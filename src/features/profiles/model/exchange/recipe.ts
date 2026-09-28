// SARD-THEME/1 — the dialect a هيئة is designed in, outside Sard.
//
// WHAT THIS IS FOR. A reader takes a picture to whatever AI they use, hands it a brief Sard wrote,
// and gets a design back as text. This module is the whole of that text's TRUST BOUNDARY, and it is
// deliberately PURE: no IPC, no filesystem, no stores. It is the same contract `package.ts` states
// for itself, for the same reason — a validator that cannot be called in a unit test is a validator
// nobody proves, and this one stands between a stranger's paragraph and the reader's settings.
//
// THE DIALECT IS NOT THE STORAGE MODEL, AND THAT IS LOAD-BEARING. `voice.sentenceColor`, not
// `ttsSpotlightColor`; `measure`, not `type.reading`; `blur` as a percentage, not pixels. The
// translation costs one table. What it buys is a firebreak: a recipe that used the internal names
// would be one rename away from letting a stranger write a settings row by guessing a key.
//
// SARD RENDERS WHAT THE RECIPE SAYS. Nothing here improves a design. A value Sard can represent is
// carried through untouched, however it measures; a value Sard cannot represent is DROPPED and
// named, and the reader's own value stands in its place. There is no clamp, no nearest-legal value
// and no fallback derived from a rejected input — see `translate.ts`, which is where that rule has
// to survive review.

import { ARABIC_DEFAULTS } from "../../../../reader-engine/injectedCss";
import { HIGHLIGHT_SLOTS } from "../../../../theme/tokens";
import { FORBIDDEN_DATA_KEYS, forbiddenIn } from "../package";
import { RELIEF_MAX } from "../palette";
import { PROFILE_READING_FIELDS } from "../profile";

/** The dialect's own version. Not Sard's, not the package format's, not `ProfileData`'s. */
export const RECIPE_FORMAT = "SARD-THEME/1";

/** The dialect's family, so a `SARD-THEME/2` can be recognised and refused by name rather than as junk. */
export const RECIPE_FAMILY = "SARD-THEME";
export const RECIPE_VERSION = 1;

/**
 * A recipe larger than this is not a recipe.
 *
 * A full two-palette design with its reasoning measures around 3 KB. 32 KiB is ten times the largest
 * plausible one, and far below the package manifest's 1 MiB — which is the right ceiling for an
 * archive and much too generous for a paragraph of text someone pasted.
 */
export const MAX_RECIPE_BYTES = 32 * 1024;

/** The fence label the brief asks for. It is a USER-EXPERIENCE decision as much as a parsing one:
 *  every chat interface draws a copy button around a fenced block, so this is what makes the
 *  reader's return trip a single click on the AI's own button. */
export const RECIPE_FENCE = "sard-theme";

// ---- refusals: the whole document turned away -----------------------------------------------

export type Refusal =
  | { code: "rcp.err.notADesign" }
  | { code: "rcp.err.unreadable" }
  | { code: "rcp.err.notSard" }
  | { code: "rcp.err.newer"; found: string }
  | { code: "rcp.err.tooLarge"; bytes: number }
  | { code: "rcp.err.carriesReadingSettings"; field: string };

export type Inspection =
  | { ok: true; raw: Record<string, unknown>; findings: Finding[] }
  | { ok: false; refusal: Refusal };

// ---- findings: one field's fate, never the document's ------------------------------------------

/**
 * WHY EVERY FINDING CARRIES THE SUPPLIED VALUE AND THE BOUND.
 *
 * The reader is told "lineHeight 40 — outside 1.2 to 2.6", not "invalid value". The first sentence
 * can be acted on: they can go back to the AI and ask for a number inside the range. The second
 * tells them only that something went wrong somewhere.
 *
 * `drop` is the only outcome that loses anything, and it loses exactly one field. `note` changes
 * nothing at all and exists so the reader can see what Sard saw.
 */
export type Finding =
  /** Out of range. The value is read, reported, and discarded — it never informs what replaces it. */
  | { kind: "drop"; code: "rcp.drop.range"; path: string; value: unknown; min: number; max: number }
  /** Not one of the names this field accepts. */
  | { kind: "drop"; code: "rcp.drop.vocab"; path: string; value: unknown; allowed: readonly string[] }
  /** Not a colour Sard can read. */
  | { kind: "drop"; code: "rcp.drop.colour"; path: string; value: unknown }
  /** The wrong shape entirely — a string where a number belongs, an array where an object does. */
  | { kind: "drop"; code: "rcp.drop.type"; path: string; value: unknown; want: string }
  /** A face this copy does not have. Sard does not pick a substitute; the reader's own face stands. */
  | { kind: "drop"; code: "rcp.drop.face"; path: string; value: unknown }
  /** A key the dialect has no meaning for. Counted so the reader knows a setting did not arrive. */
  | { kind: "drop"; code: "rcp.drop.unknown"; path: string }
  /**
   * A setting a هيئة really owns that THIS DIALECT cannot express — the three absolute pixel
   * lengths. Told apart from an invented key on purpose: the design asked for something reasonable,
   * so the reader should hear a reason rather than "not understood", and the author should hear
   * that the field exists and is simply not carried yet.
   */
  | { kind: "drop"; code: "rcp.drop.notExpressible"; path: string; value: unknown; why: string }
  /** A library-only field offered on the reading palette. `relief` is the only one today. */
  | { kind: "drop"; code: "rcp.drop.scope"; path: string; value: unknown }
  /** A required field the recipe did not state. Absence is not a design decision, so Sard fills it. */
  | { kind: "note"; code: "rcp.note.filled"; path: string; from: string }
  /** The palette says one polarity and its paper measures the other. Reported; NOT corrected. */
  | { kind: "note"; code: "rcp.note.polarity"; path: string; claimed: boolean; measured: boolean }
  /** A unit the brief declares in advance: a percentage into Sard's own scale. Not a correction. */
  | { kind: "note"; code: "rcp.note.converted"; path: string; from: number; to: number; unit: string };

export const isDrop = (f: Finding): boolean => f.kind === "drop";

// ---- the vocabulary, derived from the product rather than restated -----------------------------

/**
 * THE KEYS THE DIALECT KNOWS, and nothing else is read.
 *
 * An unknown key is not an error — it is a setting the reader believes they got and did not, so it
 * is counted and named. That is why these lists exist at all: without them an invented field would
 * vanish in silence, which is the one outcome the format cannot afford.
 */
/**
 * WHAT THE DIALECT CARRIES — AND THE LINE IT IS DRAWN ALONG.
 *
 * A design decides the VISUAL IDENTITY: the two palettes, the marks' colours, the texture. It does
 * not decide the READING TYPOGRAPHY — the faces, the text size, the indent — because those are the
 * reader's, and because the evidence says wording cannot move them anyway: across ten cold runs
 * every model chose a text size in 1.1..1.15 of a 0.8..2.5 range, unmoved by removing the examples
 * that were suspected of anchoring it. A boundary that is enforced by the format cannot be argued
 * with by a brief, which is why it is drawn here rather than in prose.
 */
export const TOP_KEYS = [
  "format", "name", "description", "author", "notes",
  "palette", "voice", "reference", "texture", "checks",
] as const;

export const PALETTE_KEYS = [
  "dark", "paperBg", "surfaceBg", "chromeBg", "chromeBorder", "text", "muted", "accent",
  "selection", "highlight", "bookmark", "numbers", "relief",
] as const;

/** The six colours of a palette that must be a plain hex. `text` is among them, and is the ink. */
export const PALETTE_SOLID = [
  "paperBg", "surfaceBg", "chromeBg", "text", "muted", "accent",
] as const;

/** The two that may legitimately carry alpha, exactly as `ThemeColors` allows. */
export const PALETTE_WASH = ["chromeBorder", "selection"] as const;

/** Optional, and `null` in the model means "follow something else" — so absence is meaningful. */
export const PALETTE_OPTIONAL_COLOUR = ["bookmark", "numbers"] as const;

/** The read-aloud marks a design may colour: the two colours and the two strengths, nothing else. */
export const VOICE_KEYS = [
  "sentenceColor", "sentenceOpacity", "wordColor", "wordOpacity",
] as const;

/** The reference rule's colour. Its weight and offset are geometry and stay with the reader. */
export const REFERENCE_KEYS = ["color"] as const;

export const TEXTURES = ["opaque", "light", "glass"] as const;

/**
 * WHAT A هيئة OWNS AND THIS DIALECT DELIBERATELY DOES NOT CARRY, each with the reason.
 *
 * Two different kinds of absence live here and the difference matters to whoever reads the report.
 *
 * THE READER'S OWN. The faces, the text size and the indent are chosen in Sard, by the person who
 * will read at that size on their own screen. Nothing about a picture tells a designer how large
 * someone's text should be.
 *
 * GEOMETRY AND TREATMENT. Page width, leading, the picture's presence, its blur, the page's own
 * opacity, the bookmark's shape and place — these decide the SHAPE of a reading surface rather than
 * its colour, and this version of the exchange is about colour.
 *
 * ABSOLUTE PIXEL LENGTHS. `marginPx`, `letterSpacing` and `paragraphSpacing` could not be carried
 * even if they belonged here: every size this dialect can set is a ratio, and a pixel does not
 * survive a change of text size, window or screen. The measured case is on the record — a stored
 * `marginPx` of 136 gave a fifth of the page to margin under a هيئة that never asked for it.
 *
 * NONE OF THESE IS A REFUSAL. A recipe naming one asked for something reasonable that this dialect
 * cannot carry: the field is dropped, the reader's own value stands, and the report says which kind
 * of absence it was. THE BRIEF READS THIS LIST rather than restating it, so the document a model is
 * handed cannot quietly disagree with the validator that judges its reply.
 */
export const NOT_EXPRESSIBLE: Readonly<Record<string, string>> = {
  // the reader's own, and said so in the brief
  ui: "the interface face; the reader chooses it",
  arabic: "the Arabic book face; the reader chooses it",
  latin: "the Latin book face; the reader chooses it",
  zoom: "the text size; the reader chooses it, at their own distance from their own screen",
  firstLineIndent: "the first-line indent; the reader chooses it",
  // geometry and treatment, not colour
  pageWidth: "the measure's width; geometry rather than colour",
  lineHeight: "the leading; geometry rather than colour",
  fontWeight: "the ink's weight; the reader's own",
  align: "the alignment; the reader's own",
  diacritics: "whether diacritics show; the reader's own",
  presence: "how much of a picture shows; the reader's own treatment of their own picture",
  blur: "how far a picture is blurred; the reader's own treatment",
  pageOpacity: "how solid the page is over a picture; the reader's own treatment",
  overlay: "the scrim over a picture; the reader's own treatment",
  bookmarkShape: "the bookmark's shape; only its COLOUR belongs to a design",
  bookmarkSize: "the bookmark's size",
  bookmarkPos: "where the bookmark hangs",
  readMarker: "the progress mark's style; only its colour follows the palette",
  seal: "the seal's face and glyph",
  // absolute pixel lengths, which no version of this dialect can carry
  marginPx: "a margin in pixels; no size here is absolute",
  letterSpacing: "tracking in pixels, and Latin-only - it breaks Arabic cursive joining",
  paragraphSpacing: "paragraph spacing in pixels",
};

export const SLOT_KEYS = HIGHLIGHT_SLOTS;

/**
 * THE FIREWALL'S REACH, restated here only as a re-export so there is exactly one derivation.
 *
 * `package.ts` computes it from `ARABIC_DEFAULTS` minus `PROFILE_READING_FIELDS`, plus the two
 * settings-row names. A second copy here would be the third hand-written copy of that list in this
 * codebase's history, and both previous copies drifted, and each drift was a real defect.
 */
export { FORBIDDEN_DATA_KEYS, forbiddenIn };

/**
 * WHAT SARD DOES TO A PALETTE AT RENDER TIME, told to the designer in advance.
 *
 * Sard renders what a recipe says. These are the places where what reaches the screen is not
 * character-for-character what was authored, and every one of them PREDATES this feature and
 * applies to every هيئة alike — the sixteen built-in papers, one made by hand in the editor, and
 * one that arrived as a design. Nothing here was added for designs that come from an AI, and
 * nothing here is a new correction.
 *
 * They are listed because a designer who knows them picks better colours, and because a brief that
 * withheld them would be promising a fidelity the product does not have. The brief renders this
 * list rather than restating it, so the document a model reads cannot drift from the code.
 *
 * VERIFIED BY CALL SITE, NOT BY COMMENT. `guidance.ts` names four resolvers of this kind in its
 * header; two of the four are not what they sound like. `resolveMarkOnGround` is exported and
 * NEVER CALLED anywhere in the product, so it moves nothing today and is not listed. `regroundFaint`
 * is live but computes a derived token (`--bg-lib-faint`) from the palette rather than altering a
 * colour a recipe set, so it is not a fidelity exception either.
 */
export const RENDER_NOTES: readonly { subject: string; note: string }[] = [
  {
    subject: "muted",
    note:
      "held to 3.0 against chromeBg, paperBg and surfaceBg. A value below that is drawn stronger. " +
      "Clear 3.0 on all three and it is drawn exactly as you set it.",
  },
  {
    subject: "the progress marks",
    note:
      "have no colour of their own: they are drawn from your accent and your muted against the " +
      "panel, and are held to the same 3.0 there.",
  },
  {
    subject: "the highlight pens",
    note:
      "are drawn as translucent washes, not flat fills - multiply on a light page, screen on a " +
      "dark one - and on a dark palette each pen is mixed toward the paper first. Pick pens for " +
      "how they read THROUGH text, not as blocks of colour.",
  },
  {
    subject: "text on paperBg",
    note:
      "is not floored at all. However dark or pale you make the page's ink, that is exactly what " +
      "the reader sees.",
  },
];

/** The two palettes a design dresses, named once so nothing counts them by hand. */
export const SCOPES = ["library", "reading"] as const;
export type Scope = (typeof SCOPES)[number];

/**
 * THE PAIRS SARD RECOMPUTES, and therefore the only claim names it can compare.
 *
 * Derived from the two scopes so a third could never leave this behind, and shared by the brief
 * (which publishes the names a model may use) and the measurement pass (which computes them). One
 * derivation, so the document cannot ask for a name the measurer does not know.
 *
 * A claim under any other name is accepted and simply not compared — a model showing more arithmetic
 * than Sard asked for is being careful, and should not be corrected for it.
 */
export const CHECK_PAIRS = [
  "TextOnPaper", "TextOnChrome", "MutedOnPaper", "MutedOnChrome", "MutedOnSurface", "AccentOnChrome",
] as const;

export const CHECK_NAMES: readonly string[] = SCOPES.flatMap((s) => CHECK_PAIRS.map((p) => `${s}${p}`));

/** What the vocabulary pin asserts against. Exported so the test reads the same numbers the code does. */
export const VOCABULARY_SIZES = {
  readingFields: PROFILE_READING_FIELDS.length,
  engineFields: Object.keys(ARABIC_DEFAULTS).length,
  slots: SLOT_KEYS.length,
} as const;

// ---- bounds: every one read from the constant that defines it ----------------------------------

export interface Bound {
  min: number;
  max: number;
}

/**
 * NOT ONE OF THESE NUMBERS IS A LITERAL, and that is the whole anti-drift argument.
 *
 * A brief and a validator that restate a range by hand fall behind the product on the first change.
 * Reading the constant means `RELIEF_MAX` moving moves the bound, the brief and the test together,
 * or the build fails.
 *
 * THE TWO WRITTEN OUT ARE WRITTEN OUT DELIBERATELY. `lineHeight` and `bookmarkPos` have no exported
 * constant to read — the first lives on the reader's own slider (1.2 … 2.6) and the second is a
 * fraction by construction. They are marked so a future constant can replace them.
 */
export const BOUNDS: Record<string, Bound> = {
  "palette.relief": { min: -RELIEF_MAX, max: RELIEF_MAX },
  "voice.sentenceOpacity": { min: 0, max: 1 },
  "voice.wordOpacity": { min: 0, max: 1 },
};


// ---- extraction: finding the design inside whatever was pasted ---------------------------------

const FENCE = /```[ \t]*([A-Za-z0-9_-]*)[ \t]*\r?\n([\s\S]*?)```/g;

/**
 * Pull the design out of a reply, a file, or a bare object.
 *
 * TOLERANT ON PURPOSE. Models format inconsistently — some label the fence, some do not, some wrap
 * it in prose and some return the object alone. That is Sard's problem to absorb, not the reader's,
 * and every tolerance here removes a way for a perfectly good design to be refused over punctuation.
 *
 * THE LAST BLOCK WINS. A conversation pasted whole may hold several attempts, and the last one is
 * the one the reader was looking at when they copied. The caller reports that it chose.
 */
export function extractRecipe(text: string): { body: string; blocks: number } | null {
  if (typeof text !== "string") return null;
  const candidates: string[] = [];
  FENCE.lastIndex = 0;
  for (let m = FENCE.exec(text); m; m = FENCE.exec(text)) {
    const label = (m[1] || "").toLowerCase();
    const body = m[2];
    // A labelled fence is taken on its label; an unlabelled or oddly-labelled one is taken only if
    // it actually claims to be a design, so a stray code block in the reply is not mistaken for one.
    if (label === RECIPE_FENCE || body.includes(RECIPE_FAMILY)) candidates.push(body);
  }
  if (candidates.length > 0) {
    return { body: candidates[candidates.length - 1], blocks: candidates.length };
  }
  // No fence at all: the reader may have copied the object itself.
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.includes(RECIPE_FAMILY)) return { body: trimmed, blocks: 1 };
  return null;
}

/**
 * Read a recipe and decide whether it may enter. Pure and total: every path returns, nothing throws,
 * and the refusal says which rule was broken so the UI can name it in the reader's language.
 *
 * REFUSAL IS FOR THE DOCUMENT, NOT FOR A FIELD. Only four things turn a whole design away: it is not
 * one, its text is damaged, it asks for a newer Sard, or it reaches outside what a هيئة owns. Every
 * other complaint is a finding about one field, and the rest of the design still arrives.
 */
export function inspectRecipe(text: string): Inspection {
  if (typeof text !== "string" || text.length === 0) {
    return { ok: false, refusal: { code: "rcp.err.notADesign" } };
  }
  if (text.length > MAX_RECIPE_BYTES) {
    return { ok: false, refusal: { code: "rcp.err.tooLarge", bytes: text.length } };
  }
  const found = extractRecipe(text);
  if (!found) return { ok: false, refusal: { code: "rcp.err.notADesign" } };

  let raw: unknown;
  try {
    raw = JSON.parse(found.body) as unknown;
  } catch {
    // The block is there and its text is damaged — which is what a half-copied selection looks like,
    // and a different thing to tell the reader than "that is not a design".
    return { ok: false, refusal: { code: "rcp.err.unreadable" } };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, refusal: { code: "rcp.err.unreadable" } };
  }
  const o = raw as Record<string, unknown>;

  // A document that does not claim to be a Sard design is not one. Checked before the version, so a
  // random JSON file is refused as foreign rather than as "from a newer Sard".
  if (typeof o.format !== "string" || !o.format.startsWith(`${RECIPE_FAMILY}/`)) {
    return { ok: false, refusal: { code: "rcp.err.notSard" } };
  }
  const version = Number(o.format.slice(RECIPE_FAMILY.length + 1));
  if (!Number.isFinite(version)) {
    return { ok: false, refusal: { code: "rcp.err.notSard" } };
  }
  // NEWER IS REFUSED, OLDER IS NOT — the same rule the package format keeps, for the same reason: a
  // later dialect may carry meaning this one cannot see, and importing it would discard that in
  // silence. Models do invent version numbers, so the message says so rather than blaming the file.
  if (version > RECIPE_VERSION) {
    return { ok: false, refusal: { code: "rcp.err.newer", found: o.format } };
  }

  // THE FIREWALL, AT THE BORDER. A design never carries the reader's layout, so a recipe claiming to
  // is malformed by definition — refused by name rather than stripped in silence. Derived, depth
  // bounded, and matching a key wherever it appears.
  const forbidden = forbiddenIn(o);
  if (forbidden) {
    return { ok: false, refusal: { code: "rcp.err.carriesReadingSettings", field: forbidden } };
  }

  const findings: Finding[] = [];
  if (found.blocks > 1) {
    // Not a fault, but the reader should know which one they are looking at.
    findings.push({ kind: "note", code: "rcp.note.filled", path: "format", from: `${found.blocks} designs; took the last` });
  }
  return { ok: true, raw: o, findings };
}
