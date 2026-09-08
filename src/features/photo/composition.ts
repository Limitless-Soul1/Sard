// THE CARD DOCUMENT — what a photo card IS, rather than what it happened to render as.
//
// ## Why this exists
//
// A saved card used to be a PNG plus a handful of columns. The design that produced it was not
// written down: style, text size and the show-on-card toggles were never stored, so reopening a card
// for editing silently rebuilt it as a Minimal, auto-fit card with default toggles — and saving then
// overwrote the good PNG with the wrong one. That is not a bug to patch in isolation; there was no
// document to restore. This file is the document.
//
// ## The coordinate system, and why it is this one
//
// An element's placement is a rectangle in the card's OWN LOGICAL SPACE: `x` is the inline-start
// edge, `y` the block-start edge, `w`/`h` the inline/block size, every one a fraction of the canvas
// (0..1). Three properties follow from that choice, and each was a requirement:
//
//   · DIRECTION IS FREE. `x` means "from the start edge", so a composition built around an Arabic
//     quote is still correct when the same design meets an English one. CSS resolves it natively
//     through `inset-inline-start` / `inline-size`; there is no mirroring code to get wrong, and the
//     export path inherits the behaviour because it rasterises the same DOM.
//   · SCALE IS FREE. The card renders at HALF its export size and rasterises at pixelRatio 2, so
//     every proportional value in the existing renderer already comes from `s(n) = W * n`. Fractions
//     are that idiom generalised: the preview and the export agree by construction rather than by
//     two code paths staying in step.
//   · ASPECT IS FREE. Changing format keeps every element proportionally where the user put it.
//
// The alternative considered and rejected was an anchor (start/centre/end) plus an offset. It is
// equally correct on direction, but it carries two concepts and a sign convention per element where
// this carries one, and it buys nothing back while everything on a card scales with the card.
//
// `mirror: false` is the escape hatch for the rare element — a signature, a logo — that should stay
// physically placed in both directions. Absent means logical, so the common case costs no field.
//
// ## Presets did not become limits; they became the starting point
//
// The document keeps the five styles, the text-size steps and the meta toggles, because they are
// good shortcuts. `elements` empty means "render the preset exactly as this card has always
// rendered" — which is what makes an existing card open unchanged. The moment the user moves or
// edits something, that part becomes an element with an explicit rect seeded from where the preset
// had put it, and the preset stops governing it. Shortcut, not ceiling.
//
// ## Forward compatibility
//
// An element whose `kind` this version does not know is kept verbatim and written back untouched.
// A template made by a later version therefore survives a round-trip through an older one instead of
// being silently stripped. Unrecognised top-level keys are preserved the same way.

import { HALO_WIDTH_MAX_EM, isLegibility, isLegibilityShape, type Legibility, type LegibilityShape } from "./legibility";
import {
  CARD_STYLES, DEFAULT_META, FORMATS, TEXT_SIZE_FRACTIONS,
  type CardFormat, type CardMeta, type CardStyle, type QuoteAlign, type QuoteSpacing,
  type QuoteWeight, type TextSize,
} from "./photo";

export const COMPOSITION_VERSION = 1;

/** A rectangle in the card's logical space. Fractions of the canvas; `x` is the INLINE-START edge. */
export interface Rect { x: number; y: number; w: number; h: number; }

export interface Placement {
  rect: Rect;
  /** Degrees, clockwise. Text is allowed to rotate, but the fit measurement assumes 0 (see `fits`). */
  rotate?: number;
  /** Absent or true = logical placement (mirrors with direction). False = physical, never mirrors. */
  mirror?: boolean;
}

export type TextKind = "quote" | "text" | "attribution";
export type ElementKind = TextKind | "image";

/** Every length here is a FRACTION of the canvas inline size, for the reasons in the header. */
export interface TextStyle {
  /** null = the card's own quote face. */
  family?: string | null;
  /** null = auto-fit (measured). A number is an explicit size and is used verbatim. */
  size?: number | null;
  weight?: QuoteWeight | number;
  lineHeight?: number;
  letterSpacing?: number;
  paragraphSpacing?: number;
  align?: "start" | "center" | "end" | "justify";
  /** null = the theme's ink. */
  color?: string | null;
  opacity?: number;
  /** "auto" lets the text's own script decide; an explicit value pins it. */
  dir?: "auto" | "rtl" | "ltr";
  /**
   * HOW THIS TEXT HOLDS ITS OWN OVER A BUSY GROUND — see `legibility.ts` for what each one draws.
   * Absent means «بلا», so every card saved before this renders exactly as it did.
   */
  legibility?: Legibility;
  /** 0..1. How present the treatment is; 0 is the same as none. */
  legibilityStrength?: number;
  /** 0..1. How it meets what is around it — the halo's reach, the veil's fade, the plate's edge. */
  legibilitySoftness?: number;
  /** The reader's own colour for the treatment. Absent/null = derived from the card — see `backingColor`. */
  legibilityColor?: string | null;
  /** Plate only: one surface behind the block, or one behind each line. */
  legibilityShape?: LegibilityShape;
  /**
   * HALO ONLY · em · HOW THICK THE HALO ITSELF IS.
   *
   * Distinct from `strokeWidth`, and the distinction is the point: a stroke is an outline drawn on
   * the letterform, and this is the mass of the halo standing off it. Absent means none, which is
   * the halo every card saved before this control existed carries.
   */
  haloWidth?: number;
  /**
   * A LINE AROUND THE LETTERS, in em — so it scales with the type rather than with the card, and a
   * card that changes format keeps the relationship the reader chose. 0 or absent is no stroke,
   * which is what every card saved before this has.
   *
   * It is a TEXT property and not a fourth readability treatment, deliberately: a stroke composes
   * with a halo, a veil or a plate rather than replacing one, and putting it in the mode list would
   * have made the reader choose between two things that work best together.
   */
  strokeWidth?: number;
  /** null/absent = derived from the words and the card — see `strokeColor` in `legibility`. */
  strokeColor?: string | null;
}

/**
 * Which part of the preset layout this element took over, if any.
 *
 * The preset is a starting point, not a cage: clicking the quote on the card LIFTS it into a real
 * element, seeded from the measured position and type of the preset's own node, so the card does not
 * move a pixel and the words become editable. This marker is how the preset knows to stop drawing
 * that one part — it hides the node while keeping its space, which is what stops everything below
 * from sliding up.
 */
export type PresetPart =
  | "quote"
  | "title"
  | "chapter"
  | "author"
  | "attribution"
  /**
   * The preset draws the chapter and the author as ONE credit line, so a card lifted from it carries
   * this instead of the two separate roles. Kept forever: documents saved before the roles were
   * separated name it, and dropping it would strip their credit line on the next open.
   */
  | "subtitle";

export interface TextElement {
  id: string;
  kind: TextKind;
  placement: Placement;
  style: TextStyle;
  /** The words. For `quote` this starts as the passage and is then the user's to change. */
  text: string;
  /** Set when this element replaced a part of the preset layout. */
  origin?: PresetPart;
  hidden?: boolean;
  /**
   * WHICH STYLE PROPERTIES THE READER SET THEMSELVES — the ownership record.
   *
   * A composition rearranges the card, and to do that it works out sizes, spacing and alignment from
   * the words. Before this existed it wrote the whole style back, so choosing a second composition
   * threw away the face, the size, the treatment and the alignment the reader had chosen: their work
   * was destroyed by an act they thought was decorative.
   *
   * The fix is not to make compositions weaker; it is to know who owns what. A key listed here was
   * set by hand and a composition may not touch it. Everything else belongs to the composition,
   * which is what makes applying one still mean something.
   *
   * Absent on a card saved before this, and such a card falls back to the older rule — colour and
   * face survive, the rest is the composition's — so nothing already saved changes behaviour.
   */
  own?: (keyof TextStyle)[];
}

export interface ImageElement {
  id: string;
  kind: "image";
  placement: Placement;
  /** A managed background-store id. NEVER a path — see `referencedAssets`. */
  assetId: string;
  fit?: "cover" | "contain";
  focalX?: number;
  focalY?: number;
  opacity?: number;
  /** Rounded corners, as a fraction of the element's inline size. */
  radius?: number;
  /** Gaussian blur in export pixels. A picture can be scenery as well as subject. */
  blur?: number;
  /**
   * MIRRORED, NOT REWRITTEN. A flip is a property of how the picture is DRAWN — a negative scale on
   * the same `<img>` — so the stored image is never touched, the flip costs nothing, and it
   * composes with the fit, the focal point, the rotation and the corner radius exactly as they
   * already compose with each other.
   */
  flipX?: boolean;
  flipY?: boolean;
  hidden?: boolean;
}

/** An element from a newer version. Kept whole so it round-trips instead of being dropped. */
export interface UnknownElement {
  id: string;
  kind: "unknown";
  hidden?: boolean;
  raw: Record<string, unknown>;
}

export type CardElement = TextElement | ImageElement | UnknownElement;

export type Ground =
  | {
      kind: "theme";
      themeId: string;
      /**
       * A paper colour the user chose outright. The shipped papers are shortcuts; this is what
       * removes their ceiling, and it wins over the theme when set.
       */
      paper?: string;
    }
  | {
      kind: "image";
      assetId: string;
      /** The ink still comes from a theme even when the ground is a photograph. */
      themeId: string;
      /**
       * HOW THE PHOTOGRAPH IS COMPOSED.
       *
       * `fit` and the focal point alone can only ever answer "which part of it survives the crop",
       * which is a cropping tool, not a composition. A ground is an object on the card: it has a
       * place, a size and a weight. So the base sizing is still `fit`, and then `scale` grows it
       * from there and `offsetX`/`offsetY` move it — both as fractions of the card, so they survive
       * a change of format exactly the way an element's rect does.
       */
      fit?: "cover" | "contain";
      /** The focal point WITHIN the frame — which part of the picture the crop keeps. */
      focalX?: number;
      focalY?: number;
      /** 1 = exactly what `fit` produced. Above that it is zoomed in and the card crops it. */
      scale?: number;
      /** Fractions of the card, from the centre. Positive is inline-end / block-end. */
      offsetX?: number;
      offsetY?: number;
      opacity?: number;
      blur?: number;
      /** Mirrored on the way to the screen; the stored picture is untouched. See `ImageElement`. */
      flipX?: boolean;
      flipY?: boolean;
      /** 0..1 veil over the photograph, beneath every element. */
      scrim?: number;
    };

/** The preset layer — today's card, kept as the starting point rather than as the ceiling. */
/**
 * WHICH FORM THE SARD MARK TAKES.
 *
 * `lockup` is the hoopoe with both wordmarks and is what every card made before this existed had, so
 * it is the default and nothing already saved changes. The other two are for a card whose own
 * composition is busy enough that the full lockup would be a fourth voice on it.
 */
export type BrandVariant = "lockup" | "wordmark" | "bird";
export const BRAND_VARIANTS: BrandVariant[] = ["lockup", "wordmark", "bird"];

/**
 * WHERE ALONG THE FOOT THE MARK SITS.
 *
 * PHYSICAL, not logical, and deliberately: the user is choosing a place on a picture they are
 * looking at, so "left" has to mean left. Absent means "the side the card reads from", which is
 * what every card made before this had — right for an Arabic card, left for an English one.
 */
export type BrandAlign = "left" | "center" | "right";
export const BRAND_ALIGNS: BrandAlign[] = ["left", "center", "right"];

export interface Preset {
  style: CardStyle;
  textSize: TextSize;
  meta: CardMeta;
  quoteFont?: string | null;
  quoteWeight?: QuoteWeight;
  quoteSpacing?: QuoteSpacing;
  quoteAlign?: QuoteAlign;
  /** Absent means `lockup` — see BrandVariant. Whether it is drawn at all is `meta.brand`. */
  brandVariant?: BrandVariant;
  /** Absent means the side the card reads from — see BrandAlign. */
  brandAlign?: BrandAlign;
  /**
   * The mark's own place, as fractions of the card (its top-left). Absent means "wherever
   * `brandAlign` puts it", which is what every card made before the mark could be moved has.
   */
  brandPos?: { x: number; y: number };
  /** Fraction of the card's width. Absent means the size the mark has always been. */
  brandSize?: number;
  brandOpacity?: number;
}

export interface Composition {
  v: number;
  /** `dir` is the CARD's own direction — the editor's chrome follows the reader's language instead. */
  canvas: { format: CardFormat; w: number; h: number; dir?: "rtl" | "ltr" };
  ground: Ground;
  preset: Preset;
  /** Ordered back-to-front. Empty = render the preset exactly as it has always rendered. */
  elements: CardElement[];
  /** A card whose text is the user's own, with no book behind it. */
  custom?: boolean;
  /** Top-level keys a newer version wrote. Preserved verbatim. */
  ext?: Record<string, unknown>;
}

// ---- helpers ------------------------------------------------------------------------------------

const clamp = (n: number, lo: number, hi: number): number => (n < lo ? lo : n > hi ? hi : n);
const num = (v: unknown, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;
const str = (v: unknown, fallback: string): string => (typeof v === "string" ? v : fallback);

/** Ids are stable across a round-trip, so a template can refer to an element it did not create. */
export function newId(): string {
  const g = globalThis as { crypto?: { randomUUID?: () => string } };
  if (g.crypto && typeof g.crypto.randomUUID === "function") return g.crypto.randomUUID();
  return "el-" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

export function formatSize(format: CardFormat): { w: number; h: number } {
  const f = FORMATS.find((x) => x.key === format) ?? FORMATS[1];
  return { w: f.w, h: f.h };
}

/**
 * EVERY managed image this composition depends on, ground and elements alike.
 *
 * This is the function the garbage collector's reference source is built from. It exists because the
 * collector must be able to learn what a card references WITHOUT parsing this document: the ids it
 * returns are written to their own table beside the card, in the same write. Keeping the binding out
 * of the JSON is what makes "no orphaned image, no missing image" a property of the schema instead of
 * a promise the UI has to keep.
 */
/** Which preset parts have been lifted, and must therefore stop being drawn by the preset. */
/**
 * IS THE PRESET'S OWN DRAWING OF THIS PART SUPPRESSED?
 *
 * A part goes quiet once it has been lifted: it is an element now, and the preset must stop drawing
 * it or the same words appear twice. The credit line is the one that is not one-to-one — the preset
 * draws the chapter and the author JOINED, so lifting either half retires the whole line.
 */
export function presetHidden(lifted: Set<PresetPart>, part: PresetPart): boolean {
  if (lifted.has(part)) return true;
  return part === "subtitle" && (lifted.has("chapter") || lifted.has("author"));
}

export function liftedParts(comp: Composition): Set<PresetPart> {
  const out = new Set<PresetPart>();
  for (const el of comp.elements) {
    if (el.kind !== "unknown" && el.kind !== "image" && el.origin) out.add(el.origin);
  }
  return out;
}

export function referencedAssets(comp: Composition): string[] {
  const out: string[] = [];
  if (comp.ground.kind === "image" && comp.ground.assetId) out.push(comp.ground.assetId);
  for (const el of comp.elements) {
    if (el.kind === "image" && el.assetId) out.push(el.assetId);
  }
  return [...new Set(out)];
}

// ---- the preset defaults, in one place ----------------------------------------------------------

export const DEFAULT_PRESET: Preset = {
  style: "minimal",
  textSize: "auto",
  meta: { ...DEFAULT_META },
  quoteFont: null,
  quoteWeight: 400,
  quoteSpacing: "normal",
  quoteAlign: "auto",
};

/**
 * THE COMPATIBILITY LAYER. A card saved before the document existed, rebuilt from the columns it
 * does have.
 *
 * Deterministic on purpose: the same row always produces the same composition, `elements` is always
 * empty, and the preset is always the shipped defaults — which is precisely what the old code did
 * when it reopened a card, so an existing card renders exactly as it always has. What changes is
 * only that the result is now written down and can be edited without being lost.
 */
export function compositionFromLegacy(row: {
  format?: string | null;
  theme_id?: string | null;
  quote_font?: string | null;
}): Composition {
  const format = (FORMATS.find((f) => f.key === row.format)?.key ?? "portrait") as CardFormat;
  return {
    v: COMPOSITION_VERSION,
    canvas: { format, ...formatSize(format) },
    ground: { kind: "theme", themeId: str(row.theme_id, "ivory") },
    preset: { ...DEFAULT_PRESET, meta: { ...DEFAULT_META }, quoteFont: row.quote_font ?? null },
    elements: [],
  };
}

/**
 * A CARD WITH NO BOOK BEHIND IT.
 *
 * Every metadata toggle is off and no book fields are set, because the one thing this card must never
 * do is claim a provenance it does not have. It opens with a single text element holding the user's
 * words, which is also what makes the preset stand down — the preset draws a book quote, and there
 * is no book.
 */
export function newCustomComposition(themeId: string, format: CardFormat, text: string): Composition {
  return {
    v: COMPOSITION_VERSION,
    canvas: { format, ...formatSize(format) },
    ground: { kind: "theme", themeId },
    preset: {
      ...DEFAULT_PRESET,
      meta: { date: false, time: false, title: false, chapter: false, author: false, brand: false },
    },
    // ITS WORDS ARE A QUOTE LIKE ANY OTHER, and saying so is what lets a blank card be composed.
    // Without `origin` the composition system read this as a loose element, so choosing a
    // composition had nothing to arrange — measured, pressing all four moved the card not one
    // pixel. The role carries no provenance: there is no book, no author and no chapter here, and
    // none is invented. It only says which part of a composition these words are.
    elements: [
      {
        id: newId(),
        origin: "quote",
        kind: "quote",
        placement: { rect: { x: 0.1, y: 0.22, w: 0.8, h: 0.46 } },
        style: { size: null, weight: 400, lineHeight: 1.7, align: "center", color: null, opacity: 1, dir: "auto" },
        text,
      },
    ],
    custom: true,
  };
}

// ---- parse / serialise --------------------------------------------------------------------------

const PRESET_PARTS = new Set(["quote", "title", "chapter", "author", "attribution", "subtitle"]);
const KNOWN_TOP = new Set(["v", "canvas", "ground", "preset", "elements", "custom", "ext"]);
// Validated by membership rather than by a chain of comparisons. A chain reads like this module is
// deciding something about script, which it is not — the one place that answers that question is
// `lib/typography`, and the repository has a test that keeps it that way.
const TEXT_DIRS = new Set(["auto", "rtl", "ltr"]);
/** The card's own direction. "auto" is not one of them: a canvas either runs one way or the other. */
const CANVAS_DIRS = new Set(["rtl", "ltr"]);
const TEXT_ALIGNS = new Set(["start", "center", "end", "justify"]);
/** As thick as a stroke may be, in em. Past this the counters of Arabic letterforms close up. */
export const STROKE_MAX = 0.24;
/**
 * The style properties an ownership list may name.
 *
 * Written out rather than derived, because it is the CONTRACT between the reader and a composition:
 * adding a style property does not silently make it claimable, and removing one cannot leave a
 * stored document pinning a property that no longer exists.
 */
const STYLE_KEYS = new Set<string>([
  "family", "size", "weight", "lineHeight", "letterSpacing", "paragraphSpacing", "align",
  "color", "opacity", "dir",
  "legibility", "legibilityStrength", "legibilitySoftness", "legibilityColor", "legibilityShape",
  "haloWidth",
  "strokeWidth", "strokeColor",
]);

function parseRect(v: unknown): Rect {
  const r = (v ?? {}) as Record<string, unknown>;
  return {
    x: clamp(num(r.x, 0), -2, 3),
    y: clamp(num(r.y, 0), -2, 3),
    w: clamp(num(r.w, 0.5), 0.01, 3),
    h: clamp(num(r.h, 0.2), 0.01, 3),
  };
}

function parsePlacement(v: unknown): Placement {
  const p = (v ?? {}) as Record<string, unknown>;
  const out: Placement = { rect: parseRect(p.rect) };
  if (typeof p.rotate === "number" && Number.isFinite(p.rotate)) out.rotate = clamp(p.rotate, -360, 360);
  if (p.mirror === false) out.mirror = false;
  return out;
}

function parseElement(v: unknown): CardElement | null {
  if (!v || typeof v !== "object") return null;
  const e = v as Record<string, unknown>;
  const kind = e.kind;
  const id = str(e.id, newId());
  if (kind === "quote" || kind === "text" || kind === "attribution") {
    const s = (e.style ?? {}) as Record<string, unknown>;
    const style: TextStyle = {};
    if (s.family === null || typeof s.family === "string") style.family = s.family as string | null;
    if (s.size === null) style.size = null;
    else if (typeof s.size === "number" && Number.isFinite(s.size)) style.size = clamp(s.size, 0.005, 0.5);
    if (typeof s.weight === "number") style.weight = clamp(s.weight, 100, 900);
    if (typeof s.lineHeight === "number") style.lineHeight = clamp(s.lineHeight, 0.6, 4);
    if (typeof s.letterSpacing === "number") style.letterSpacing = clamp(s.letterSpacing, -0.05, 0.5);
    if (typeof s.paragraphSpacing === "number") style.paragraphSpacing = clamp(s.paragraphSpacing, 0, 2);
    if (typeof s.align === "string" && TEXT_ALIGNS.has(s.align)) style.align = s.align as TextStyle["align"];
    if (s.color === null || typeof s.color === "string") style.color = s.color as string | null;
    if (typeof s.opacity === "number") style.opacity = clamp(s.opacity, 0, 1);
    if (typeof s.dir === "string" && TEXT_DIRS.has(s.dir)) style.dir = s.dir as TextStyle["dir"];
    // A treatment from a newer version is not honoured blindly — an unknown name would render as
    // nothing anyway, and dropping it here keeps the in-memory document to values the renderer knows.
    if (isLegibility(s.legibility)) style.legibility = s.legibility;
    if (typeof s.legibilityStrength === "number") style.legibilityStrength = clamp(s.legibilityStrength, 0, 1);
    if (typeof s.legibilitySoftness === "number") style.legibilitySoftness = clamp(s.legibilitySoftness, 0, 1);
    if (s.legibilityColor === null || typeof s.legibilityColor === "string") style.legibilityColor = s.legibilityColor as string | null;
    if (isLegibilityShape(s.legibilityShape)) style.legibilityShape = s.legibilityShape;
    if (typeof s.haloWidth === "number") style.haloWidth = clamp(s.haloWidth, 0, HALO_WIDTH_MAX_EM);
    if (typeof s.strokeWidth === "number") style.strokeWidth = clamp(s.strokeWidth, 0, STROKE_MAX);
    if (s.strokeColor === null || typeof s.strokeColor === "string") style.strokeColor = s.strokeColor as string | null;
    const el: TextElement = {
      id, kind, placement: parsePlacement(e.placement), style, text: str(e.text, ""),
    };
    if (typeof e.origin === "string" && PRESET_PARTS.has(e.origin)) el.origin = e.origin as PresetPart;
    if (e.hidden === true) el.hidden = true;
    // Only keys this version knows: an ownership list is a claim about THIS document's style, and a
    // name the renderer cannot honour would freeze a property nothing can ever change again.
    if (Array.isArray(e.own)) {
      const own = e.own.filter((k): k is keyof TextStyle => typeof k === "string" && STYLE_KEYS.has(k));
      if (own.length) el.own = [...new Set(own)];
    }
    return el;
  }
  if (kind === "image") {
    const el: ImageElement = {
      id, kind: "image", placement: parsePlacement(e.placement), assetId: str(e.assetId, ""),
    };
    if (e.fit === "contain" || e.fit === "cover") el.fit = e.fit;
    if (typeof e.focalX === "number") el.focalX = clamp(e.focalX, 0, 1);
    if (typeof e.focalY === "number") el.focalY = clamp(e.focalY, 0, 1);
    if (typeof e.opacity === "number") el.opacity = clamp(e.opacity, 0, 1);
    if (typeof e.radius === "number") el.radius = clamp(e.radius, 0, 1);
    if (typeof e.blur === "number") el.blur = clamp(e.blur, 0, 80);
    if (e.flipX === true) el.flipX = true;
    if (e.flipY === true) el.flipY = true;
    if (e.hidden === true) el.hidden = true;
    return el.assetId ? el : null;
  }
  // A kind this version does not know: keep it whole rather than drop it.
  if (typeof kind === "string") return { id, kind: "unknown", raw: { ...e } };
  return null;
}

/** How far a ground may be zoomed. Below 1 it would stop covering; 6× is already a detail crop. */
export const GROUND_SCALE_MIN = 0.2;
export const GROUND_SCALE_MAX = 6;

function parseGround(v: unknown): Ground {
  const g = (v ?? {}) as Record<string, unknown>;
  const themeId = str(g.themeId, "ivory");
  if (g.kind === "image" && typeof g.assetId === "string" && g.assetId) {
    const out: Ground = { kind: "image", assetId: g.assetId, themeId };
    if (g.fit === "contain" || g.fit === "cover") out.fit = g.fit;
    if (typeof g.focalX === "number") out.focalX = clamp(g.focalX, 0, 1);
    if (typeof g.focalY === "number") out.focalY = clamp(g.focalY, 0, 1);
    if (typeof g.scale === "number") out.scale = clamp(g.scale, GROUND_SCALE_MIN, GROUND_SCALE_MAX);
    if (typeof g.offsetX === "number") out.offsetX = clamp(g.offsetX, -2, 2);
    if (typeof g.offsetY === "number") out.offsetY = clamp(g.offsetY, -2, 2);
    if (typeof g.opacity === "number") out.opacity = clamp(g.opacity, 0, 1);
    if (typeof g.blur === "number") out.blur = clamp(g.blur, 0, 60);
    if (g.flipX === true) out.flipX = true;
    if (g.flipY === true) out.flipY = true;
    if (typeof g.scrim === "number") out.scrim = clamp(g.scrim, 0, 1);
    return out;
  }
  const theme: Ground = { kind: "theme", themeId };
  if (typeof g.paper === "string" && /^#[0-9a-f]{6}$/i.test(g.paper)) theme.paper = g.paper.toUpperCase();
  return theme;
}

function parsePreset(v: unknown): Preset {
  const p = (v ?? {}) as Record<string, unknown>;
  const m = (p.meta ?? {}) as Record<string, unknown>;
  const meta: CardMeta = { ...DEFAULT_META };
  for (const k of Object.keys(DEFAULT_META) as (keyof CardMeta)[]) {
    if (typeof m[k] === "boolean") meta[k] = m[k] as boolean;
  }
  const style = CARD_STYLES.includes(p.style as CardStyle) ? (p.style as CardStyle) : "minimal";
  const sizeOk = p.textSize === "auto" || Object.prototype.hasOwnProperty.call(TEXT_SIZE_FRACTIONS, String(p.textSize));
  const out: Preset = {
    style,
    textSize: sizeOk ? (p.textSize as TextSize) : "auto",
    meta,
    quoteFont: typeof p.quoteFont === "string" ? p.quoteFont : null,
  };
  if (p.quoteWeight === 300 || p.quoteWeight === 400 || p.quoteWeight === 700) out.quoteWeight = p.quoteWeight;
  if (p.quoteSpacing === "tight" || p.quoteSpacing === "normal" || p.quoteSpacing === "relaxed") out.quoteSpacing = p.quoteSpacing;
  if (p.quoteAlign === "auto" || p.quoteAlign === "start" || p.quoteAlign === "center" || p.quoteAlign === "justify") out.quoteAlign = p.quoteAlign;
  if (typeof p.brandVariant === "string" && BRAND_VARIANTS.includes(p.brandVariant as BrandVariant)) {
    out.brandVariant = p.brandVariant as BrandVariant;
  }
  if (typeof p.brandAlign === "string" && BRAND_ALIGNS.includes(p.brandAlign as BrandAlign)) {
    out.brandAlign = p.brandAlign as BrandAlign;
  }
  const bp = p.brandPos as { x?: unknown; y?: unknown } | undefined;
  if (bp && typeof bp.x === "number" && typeof bp.y === "number") {
    out.brandPos = { x: clamp(bp.x, -0.2, 1.2), y: clamp(bp.y, -0.2, 1.2) };
  }
  if (typeof p.brandSize === "number") out.brandSize = clamp(p.brandSize, 0.012, 0.18);
  if (typeof p.brandOpacity === "number") out.brandOpacity = clamp(p.brandOpacity, 0.05, 1);
  return out;
}

/**
 * Read a stored document. Never throws and never returns a half-built object: malformed JSON, a
 * truncated blob or a field of the wrong type all yield `null`, and the caller falls back to the
 * legacy reconstruction — which is the same behaviour a card with no document at all receives.
 */
export function parseComposition(json: string | null | undefined): Composition | null {
  if (!json) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const cv = (o.canvas ?? {}) as Record<string, unknown>;
  const format = (FORMATS.find((f) => f.key === cv.format)?.key ?? "portrait") as CardFormat;
  const dims = formatSize(format);
  const elements: CardElement[] = [];
  if (Array.isArray(o.elements)) {
    for (const e of o.elements) {
      const parsed = parseElement(e);
      if (parsed) elements.push(parsed);
    }
  }
  const ext: Record<string, unknown> = {};
  for (const k of Object.keys(o)) if (!KNOWN_TOP.has(k)) ext[k] = o[k];

  const comp: Composition = {
    v: num(o.v, COMPOSITION_VERSION),
    canvas: {
      format,
      w: clamp(num(cv.w, dims.w), 240, 4096),
      h: clamp(num(cv.h, dims.h), 240, 4096),
      // Membership, not a chain of comparisons: an `x === "rtl" || …` reads as direction winning an
      // argument with the content, which is a mistake this codebase has made and now guards against.
      ...(typeof cv.dir === "string" && CANVAS_DIRS.has(cv.dir) ? { dir: cv.dir as "rtl" | "ltr" } : {}),
    },
    ground: parseGround(o.ground),
    preset: parsePreset(o.preset),
    elements,
  };
  if (o.custom === true) comp.custom = true;
  if (Object.keys(ext).length) comp.ext = ext;
  return comp;
}

/** Write a document. Unknown elements and unknown top-level keys go back out as they came in. */
export function serializeComposition(comp: Composition): string {
  const out: Record<string, unknown> = {
    v: comp.v || COMPOSITION_VERSION,
    canvas: comp.canvas,
    ground: comp.ground,
    preset: comp.preset,
    elements: comp.elements.map((el) => (el.kind === "unknown" ? el.raw : el)),
  };
  if (comp.custom) out.custom = true;
  if (comp.ext) for (const k of Object.keys(comp.ext)) if (!KNOWN_TOP.has(k)) out[k] = comp.ext[k];
  return JSON.stringify(out);
}
