// THE COMMISSION — the document Sard hands an outside AI, generated rather than written.
//
// WHY IT IS GENERATED. A brief that restates the product's ranges by hand falls behind it on the
// first change, and the evidence is not hypothetical: a hand-written draft of this document was
// measured against the source and carried six errors within a day of being written — a field
// described as a colour that is a glyph, a range out by a factor of a hundred, two fields published
// in the wrong unit entirely, and a floor quoted from the wrong constant. Every one of them would
// have reached a stranger's model as fact.
//
// So NOT ONE RANGE, NAME OR FLOOR BELOW IS A LITERAL. Each is read from the constant, registry or
// list that defines it, and `exchangeBrief.test.ts` asserts that. Moving `RELIEF_MAX` moves the
// brief; adding a highlight pen adds it here; declaring a field NOT_EXPRESSIBLE removes it from the
// vocabulary and adds it to the list of things a design does not decide. The document a model reads
// and the validator that judges its reply are the same source of truth, or the build fails.
//
// WHAT THIS VERSION COMMISSIONS. A VISUAL IDENTITY: two palettes, the marks' colours, the texture.
// Nothing about the reading typography, and nothing about how a picture is treated. That boundary
// is not a matter of wording — it is the shape of the dialect, so a model cannot cross it however
// the document is phrased. The measured reason is on the record: across ten cold runs on an earlier
// dialect that DID publish the measure, every model chose a text size within 1.1..1.15 of a
// 0.8..2.5 range, and removing the examples suspected of anchoring it changed nothing at all. Text
// size is the reader's, at their own distance from their own screen, and the format now says so by
// being unable to carry it.

import { AA_TEXT, AAA_TEXT, NON_TEXT } from "../guidance";
import { RELIEF_MAX } from "../palette";
import type { ProfileData } from "../profile";
import type { BackgroundRow } from "../../../../lib/ipc";
import {
  BOUNDS,
  NOT_EXPRESSIBLE,
  PALETTE_OPTIONAL_COLOUR,
  RECIPE_FENCE,
  RECIPE_FORMAT,
  RENDER_NOTES,
  SLOT_KEYS,
  TEXTURES,
  type Bound,
} from "./recipe";

/** What Sard already knows about the reader's picture, when they have bound one. */
export interface BriefPicture {
  width: number;
  height: number;
  meanLuma: number | null;
}

export interface BriefOptions {
  /** `null` when Sard has no picture bound — which says nothing about whether one was supplied. */
  picture?: BriefPicture | null;
  /** The reader's current هيئة, when they asked for it as a starting point. */
  current?: ProfileData | null;
}

/** A range, written the way a person reads one. */
const range = (b: Bound | undefined): string => (b ? `${b.min} to ${b.max}` : "");

const list = (xs: readonly (string | number)[]): string => xs.join(" | ");

const NAME_COLUMN = 16;
const NOTE_INDENT = " ".repeat(NAME_COLUMN + 2);

/** A contrast floor, written as the ratio a designer checks against. */
const floor = (n: number): string => n.toFixed(1).padStart(4);

/** Wrap prose at a width that survives being pasted into any chat window. */
function wrap(text: string, width: number, indent: string): string {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    if (line && (line + " " + w).length > width - indent.length) {
      lines.push(indent + line);
      line = w;
    } else {
      line = line ? `${line} ${w}` : w;
    }
  }
  if (line) lines.push(indent + line);
  return lines.join("\n").trimStart();
}

const row = (name: string, spec: string, note = ""): string => {
  const head = `  ${name.padEnd(NAME_COLUMN)}${spec}`;
  if (!note) return head;
  const body = wrap(note, 74, NOTE_INDENT)
    .split("\n")
    .map((l, i) => (i === 0 ? `${NOTE_INDENT}${l}` : l))
    .join("\n");
  return `${head}\n${body}`;
};

/**
 * WHAT SARD KNOWS ABOUT THE PICTURE IS NOT WHETHER THERE IS ONE.
 *
 * These are two different states and an earlier version of this document confused them: with
 * nothing bound it said "There is none", while its own opening line said a picture was attached.
 * The reader's workflow is to hand the brief AND their picture to a model and bind that picture in
 * Sard afterwards, so the common case was the one the text talked the model out of.
 *
 * What Sard may not do is invent what it has not measured. No mean luminance, no dimensions unless
 * a real import produced them — an impression dressed as a measurement is worse than an admitted
 * absence.
 */
function pictureBlock(p: BriefPicture | null | undefined): string {
  const lines = ["THE PICTURE"];
  if (p) {
    lines.push(`  Sard has one bound: ${p.width} x ${p.height}.`);
    if (p.meanLuma != null) {
      const kind = p.meanLuma < 0.33 ? "a dark picture" : p.meanLuma > 0.66 ? "a light picture" : "a mid-toned picture";
      lines.push(`  Its mean luminance is ${p.meanLuma.toFixed(2)} - ${kind}.`);
    }
  } else {
    lines.push(
      "  Sard has none bound yet, so it can tell you nothing measured about one: no size,",
      "  no mean luminance. That is a fact about SARD, not about your input. It does not",
      "  mean there is no picture.",
    );
  }
  lines.push(
    "",
    "  If a picture came with this brief, THAT is what the appearance is being designed",
    "  around, and it is a design reference rather than decoration. Look at it properly",
    "  before choosing anything: what it is made of, what light it is in, what it is warm or",
    "  cool with. Then design the appearance out of that. Do not sample its dominant colours",
    "  onto the page mechanically - read its world, and build a palette that lives there.",
    "",
    "  THE PAGE'S COLOUR IS THE FIRST THING YOU DECIDE FROM IT. Not the accent, not the pens:",
    "  the sheet the book is read on, which is the largest surface in the design and the one",
    "  the reader sees next to the picture. See `palette.reading.paperBg` under THE PALETTE.",
    "",
    "  You do not decide how the picture is SHOWN. How present it is, how far it is",
    "  blurred, how solid the page is over it - those are the reader's, set with their own",
    "  controls on their own screen. You decide what the appearance looks like; they decide",
    "  how much of their picture comes through it.",
  );
  return lines.join("\n");
}

function currentBlock(current: ProfileData | null | undefined): string {
  if (!current) return "";
  const c = current.theme.reading.colors;
  const l = current.theme.library.colors;
  return [
    "",
    "WHAT THE READER HAS NOW",
    "  They asked you to work from their current appearance rather than from nothing.",
    `  Page      paper ${c.paperBg}  ink ${c.text}  accent ${c.accent}  ${current.theme.reading.dark ? "dark" : "light"}`,
    `  Library   paper ${l.paperBg}  ink ${l.text}  accent ${l.accent}  ${current.theme.library.dark ? "dark" : "light"}`,
    "  These are the values they happen to have now - not a recommendation, and not a",
    "  baseline to preserve. Keep what still belongs, change what does not, say which is which.",
  ].join("\n");
}

/**
 * Build the commission.
 *
 * The document is one string because that is what a reader copies. It is assembled rather than
 * templated so that every range, name and floor in it can come from the constant that defines it.
 */
export function buildBrief(o: BriefOptions): string {
  const out: string[] = [];
  const push = (...lines: string[]) => out.push(...lines);

  push(
    "SARD APPEARANCE COMMISSION",
    "",
    "You are designing the VISUAL IDENTITY of an appearance for Sard, a desktop reading",
    "application for Arabic and Latin books. You choose its colours and its material. You",
    "do not choose how the reader reads: the faces, the text size and the indent are theirs,",
    "and this format cannot carry them. Reply in the format at the end.",
    "",
    "The reader has given you a picture. The largest colour here is the PAGE they read on,",
    "and it settles whether the appearance belongs to that picture or merely lies on it.",
    "Decide the page first, and decide it from the picture. See rule 1.",
    "",
    "Sard wrote this itself, so the names, ranges and lists below are the ones this copy",
    "accepts. Nothing outside them exists.",
    "",
    pictureBlock(o.picture),
    currentBlock(o.current),
    "",
    "WHAT AN APPEARANCE IS",
    "  Two palettes. The LIBRARY palette dresses shelves, panels and dialogs. The READING",
    "  palette dresses the book page. They are separate on purpose: a library may be dim and",
    "  dramatic while the page it opens stays a calm sheet of paper.",
    "  Plus the colours the marks take - the bookmark, the read-aloud marks, the reference",
    "  rule - and a texture for the interface's panels.",
    "  Design them TOGETHER, as one identity built around the picture: the page's colour, the",
    "  ink on it, the muted second voice, the accent, the selection, the eight pens, the",
    "  bookmark, the reference rule, the read-aloud marks, the material. A picture with a",
    "  strong palette and a generic page is a picture behind a default, not a design.",
    "",
    "THE THREE RULES",
    "  1. THE PAGE'S COLOUR IS A DESIGN DECISION YOU OWE THE READER, NOT A DEFAULT YOU FALL",
    "     BACK ON. `paperBg` in palette.reading is the sheet the book is read on. Choose it",
    "     deliberately and choose it FROM THE PICTURE - its light, its materials, the tone its",
    "     world is lit in - so that page and picture read as one design. Then choose `text`",
    "     against the paper you actually chose, rather than against a page you assumed.",
    "     A WHITE PAGE IS A CHOICE LIKE ANY OTHER AND IS RARELY THIS ONE. #FFFFFF and the",
    "     near-whites are right only when the picture itself asks for them; reaching for white",
    "     because it is neutral or safe puts the page ON the picture instead of IN it. If the",
    "     picture's world is warm, or dim, or metallic, or green, the page has a start.",
    "     Comfortable for hours is not negotiable - but comfortable is a matter of contrast",
    "     and tone, not of being pale. Rule 2 is the arithmetic that keeps a coloured page",
    "     readable; it is not a reason to avoid one.",
    "  2. LEGIBILITY IS ARITHMETIC. WCAG 2.1 relative luminance. Both palettes are held to the",
    "     same floors:",
    `       text on paperBg                            ${floor(AAA_TEXT)}  body text, read for hours. Aim higher.`,
    `       text on chromeBg                           ${floor(AA_TEXT)}  interface labels`,
    `       muted on chromeBg, paperBg and surfaceBg   ${floor(NON_TEXT)}`,
    `       accent on chromeBg                         ${floor(NON_TEXT)}`,
    "     These are floors to design to. Sard renders your colours as you give them, measures",
    "     the ratios, and shows the reader what it measured beside what you claimed. Going",
    "     below a floor is your decision and the reader's to accept - so if you do, say why.",
    "  3. OMIT RATHER THAN GUESS. Every field is optional. Omitting one keeps the reader's own",
    "     value. Filling one is an assertion you make on their behalf. There is no other way to",
    "     say \"no opinion\", so use omission freely.",
    "",
    "WHAT SARD DOES TO YOUR COLOURS WHEN IT DRAWS THEM",
    "  None of this was added for designs that come from an AI. It is how every appearance in",
    "  Sard is drawn, including ones made by hand, and knowing it lets you design around it.",
  );

  for (const n of RENDER_NOTES) {
    push(row(n.subject, "", n.note));
  }

  push(
    "",
    "THE PALETTE - palette.library and palette.reading, each the same shape.",
    row("dark", "boolean", "Whether this palette reads as a dark one. Authored, never inferred: it drives the highlight blend, the ink's alpha and the window's own title bar."),
    row("paperBg", "#RRGGBB", "The page in the reading palette; cards and panels in the library's. The reading one is the design's largest surface and rule 1's subject: decide it from the picture, and do not leave it white by default."),
    row("surfaceBg", "#RRGGBB", "The desk the page lies on, and the window's own ground."),
    row("chromeBg", "#RRGGBB", "Toolbars, panels and dialogs."),
    row("chromeBorder", "#RRGGBB or rgba()", "The edge between a panel and what is behind it. May carry alpha."),
    row("text", "#RRGGBB", "THE MAIN TEXT COLOUR - the ink the book is read in, and the interface's own. Yours to choose, and the single most consequential colour here: rule 2's first floor is about this against paperBg."),
    row("muted", "#RRGGBB", "Secondary text: captions, counts, the quieter half of a label."),
    row("accent", "#RRGGBB", "Buttons, progress, selection marks - and the bookmark, unless you colour it."),
    row("selection", "#RRGGBB or rgba()", "The ground behind selected text. Usually a wash."),
    row("highlight", `{ ${list(SLOT_KEYS)} }`, "The eight pens a reader marks passages with. All eight together, or omit the block - a partial set leaves the others mismatched."),
    row("bookmark", "#RRGGBB", `Optional. The ribbon's own colour; omit it and it follows the accent.`),
    row("numbers", "#RRGGBB", "Optional. The ink the book's page numbers take; omit it and they follow the text."),
    row("relief", range(BOUNDS["palette.relief"]), "LIBRARY ONLY. How far panels stand off the desk behind them - signed lightness, panel minus desk. Omit it and the palette's own colours decide. The reading palette ignores it."),
    "",
    "THE MARKS' COLOURS",
    row("voice.sentenceColor", "#RRGGBB", "The band drawn under the sentence being read aloud. Omit it and it follows the theme."),
    row("voice.sentenceOpacity", range(BOUNDS["voice.sentenceOpacity"]), "How strong that band is."),
    row("voice.wordColor", "#RRGGBB", "The pill drawn on the word being spoken."),
    row("voice.wordOpacity", range(BOUNDS["voice.wordOpacity"]), "How strong that pill is."),
    row("reference.color", "#RRGGBB", "The rule that marks a reference in the text. Omit it and it follows the accent."),
    "",
    "THE MATERIAL",
    row("texture", list(TEXTURES), "How solid the interface's panels are. `opaque` is a flat panel; `glass` lets what is behind it through. It changes what a panel's own colours composite against, so a design that measured its ratios on a flat panel should say `opaque` or `light`."),
    "",
    "WHAT YOU DO NOT DECIDE",
    "  These belong to the reader, or to their own treatment of their own picture. This format",
    "  cannot carry them, so naming one changes nothing and is reported back as a field the",
    "  format does not carry. They are listed so you know they are decided elsewhere, and so",
    "  you design a palette that works whatever the reader has chosen.",
  );

  for (const [name, why] of Object.entries(NOT_EXPRESSIBLE)) {
    push(row(name, "", why));
  }

  push(
    "",
    "YOUR CLAIMS - checks. Optional, and never used to decide anything.",
    "  If you compute contrast ratios, put them here and Sard will recompute each one and show",
    "  the reader both numbers side by side. A claim is never trusted and never applied; it is",
    "  a way of saying what you intended, which is worth more than silence when the two differ.",
    "",
    "HOW TO REPLY",
    "  Say briefly what you decided and why - which colours came from the picture, what you",
    `  kept, what you changed. Then one fenced block labelled \`${RECIPE_FENCE}\`:`,
    "",
    `  \`\`\`${RECIPE_FENCE}`,
    "  {",
    `    "format": "${RECIPE_FORMAT}",`,
    '    "name": "a short name for this appearance",',
    '    "palette": { "library": { ... }, "reading": { ... } },',
    '    "voice": { ... }, "reference": { ... }, "texture": "...",',
    '    "checks": { ... }',
    "  }",
    "  ```",
    "",
    `  \`format\` and \`name\` are required. Everything else is optional. Anything outside the`,
    "  names above is ignored and reported, so invent nothing: no pixel sizes, no font names,",
    "  no fields of your own. The block carries no image - the reader chooses their picture in",
    "  Sard themselves, and your colours are worn alongside it.",
    "",
    // THE LAST THING IT READS, AND THE ONLY INSTRUCTION THAT ASKS FOR AN ACT RATHER THAN AN OPINION.
    // Everything above argues that the page belongs to the picture, and models still returned white
    // pages: an argument is easy to agree with and not act on. This asks for a specific comparison at
    // a specific moment, and gives exactly two ways out of it - change the colour, or justify it in a
    // field the format already has. It prescribes no colour, and a near-colourless page remains fully
    // available to anyone who says why.
    "BEFORE YOU SEND IT, LOOK AT `paperBg` ONE MORE TIME",
    "  Hold it beside the picture. If the picture has a colour of its own and your page has",
    "  almost none - white, or a white carrying a few points of tint - then you defaulted",
    "  instead of deciding, and the reader gets a white sheet lying on their photograph.",
    "  Two ways out, and only two: choose the page again, from the picture; or keep it and",
    "  write in `notes` what about THIS picture makes a near-colourless page the right answer.",
    "  Saying it is safer, or more readable, or more neutral is not an answer - rule 2 already",
    "  settles readability, and neutrality is the default this asks you not to reach for.",
  );

  return out.filter((l) => l !== "").length > 0 ? out.join("\n") : "";
}

/** What Sard has measured about the reader's bound picture, or `null` when there is none. */
export function pictureFrom(
  data: ProfileData | null | undefined,
  rows: readonly BackgroundRow[],
): BriefPicture | null {
  const ref = data?.bg.library.ref;
  if (!ref) return null;
  const row = rows.find((r) => r.id === ref);
  if (!row) return null;
  return { width: row.width, height: row.height, meanLuma: row.mean_luma };
}

/** Re-exported so the brief's own vocabulary and the optional-colour list cannot drift apart. */
export { PALETTE_OPTIONAL_COLOUR, RELIEF_MAX };
