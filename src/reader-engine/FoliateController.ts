// FoliateController — the only place React touches foliate-js. Wraps a <foliate-view>
// custom element and exposes a small, stable API (open / next / prev / goToLocator /
// applyStyle / onRelocate / dispose). RTL is automatic via foliate's PHYSICAL
// goLeft()/goRight() (proven RAWY-02).
//
// foliate-js is loaded as a RAW ES module via a runtime <script type="module"> tag from
// /foliate-js (public/) — Vite's import-analysis rejects importing /public files, but a
// script tag is served as-is and the browser resolves the engine's internal relative
// imports from /foliate-js/ (RAWY-09 learning).
//
// open() is IDEMPOTENT: it disposes any prior view first and, after each await, bails if
// a newer open() has superseded it — so a StrictMode double-invoke / remount can't race
// two views (RAWY-10 hardening).

import {
  buildReadingCss,
  buildDynamicCss,
  buildFontFaceCss, // RAWY-208: the @font-face sheet, isolated from the geometry sheet
  ALIGN_GATE_CLASS,
  BOOK_ALIGN_CLASS,
  FORCE_RTL_CLASS, // RAWY-253 (root A): the dir-correction marker class
  EMPTY_P_CLASS, // RAWY-253 (root B): the empty-paragraph collapse marker class
  LTR_ALIGN_CLASS, // RAWY-253 (addendum): align a kept-LTR paragraph to the book's margin
  type BookThemeFlags,
  type ReadingStyle,
  type RevealLabels,
} from "./injectedCss";
import { navIntent } from "./navIntent";
import { normalizePdfText, stripPdfArtifacts, hasSpeakableText, scorePdfDocument, PDF_TTS_ENABLED, type PdfTextScore } from "../lib/pdfText"; // RAWY-292
import { stageEnter as diagStageEnter, stageOk as diagStageOk, stageFail as diagStageFail, probePdfChain as diagProbeChain, watchFirstPage as diagWatchFirstPage } from "../lib/pdfDiag"; // DIAGNOSTIC BUILD ONLY
import { diagAttachDocument, diagNote, diagPublishUnits } from "../lib/diag"; // DIAGNOSTIC BUILD ONLY
import { renderStageOk as rStageOk, renderStageFail as rStageFail, renderDiagAdoptDoc, renderDiagNotEpub, renderDiagReset, renderDiagSurface, renderDiagTheme } from "../lib/renderDiag"; // DIAGNOSTIC BUILD ONLY
import { sanitiseBookCss, type BookCssMode } from "./cssSanitiser"; // WP-7 stage 3
import { synthesiseToc, type SectionHeading, type SynthToc } from "./tocSynth"; // WP-6A // → is always the next page; see that file for why
import { resolveSpotlight, resolvePill } from "./ttsTrack"; // RAWY-200: pure per-theme track resolution
import type { Theme } from "../theme/tokens";
import { extractChapterNumber, toWesternDigits } from "../lib/format";
// RAWY-259: the ONE ink resolution, shared with the Notes editor preview so both surfaces cannot drift.
import {
  resolveHighlightInk,
  INK_PAD_X_EM,
  INK_PAD_TOP_EM,
  INK_PAD_BOTTOM_EM,
  INK_RADIUS_EM,
  INK_EDGE_EM,
} from "../lib/highlightInk";
// RAWY-260: the reference matching engine — folding + whole-phrase scanning, kept out of this file so the
// rules stay testable and identical between the create path and the render path.
import { foldChar, findPhraseHits, type RefLite } from "../lib/references";
// RAWY-281: the reference twin rule's geometry resolver — shared with the settings panel, so the numbers
// the reader adjusts and the numbers this file draws are one object.
import { resolveRefRule, refRuleReach, refRuleBars } from "./refRule";

// RAWY-140: the per-doc PAINT sheet marker. buildDynamicCss's ink/tashkīl/scrollbar rules live in a
// <style data-sard-dyn> appended AFTER foliate's own sheet, so colour/tashkīl changes update it in
// place (a repaint) instead of re-injecting the whole sheet (foliate's setStyles → @font-face
// re-declare + expand() → the flash/jump).
const DYN_ATTR = "data-sard-dyn";
// RAWY-208: the per-doc @font-face sheet marker. The faces used to ride inside buildReadingCss, which
// foliate's setStyles replaces wholesale on EVERY geometry change — so each alignment/weight/leading
// change re-declared them, the engine dropped and re-fetched the files, and the text painted in a
// FALLBACK face for ~35-45ms before snapping back (the flash + the line re-wrap). They now live in
// their own <style data-sard-fonts>, rewritten ONLY when a font slot actually changes.
const FONT_ATTR = "data-sard-fonts";
// The ONLY fields the @font-face sheet depends on. A change to anything else must never touch it.
const FONT_STYLE_KEYS: (keyof ReadingStyle)[] = ["arabicFont", "latinFont"];
// Reading-style fields that only affect PAINT (ink colour, tashkīl visibility) — applied via the
// dynamic sheet with NO reflow. Every other field that appears in buildReadingCss (fonts, size/zoom,
// line-height, alignment, weight, spacing, flow) is GEOMETRY → a real re-inject. Fields absent from
// both lists (marginPx, pageWidth, pageFitWindow) are chrome-side (RAWY-36) — they touch neither.
// RAWY-201: pageColor joins the PAINT keys — its background rule is emitted in buildDynamicCss, so a
// change repaints via the in-place dynamic sheet with NO reflow (RAWY-140), exactly like textColor.
// backgroundColor is NOT here: it never touches the iframe (it's a reader-scoped chrome var applied by
// React), so it needs neither a re-inject nor a dynamic-sheet rewrite.
const PAINT_STYLE_KEYS: (keyof ReadingStyle)[] = ["textColor", "diacritics", "pageColor"];
const GEOMETRY_STYLE_KEYS: (keyof ReadingStyle)[] = [
  "zoom",
  "arabicFont",
  "latinFont",
  "lineHeight",
  "align",
  "fontWeight",
  "paragraphSpacing",
  "firstLineIndent",
  "letterSpacing",
  "flowMode",
];
// RAWY-200: the TTS text-tracking fields. These touch NEITHER the injected CSS nor the dynamic paint
// sheet — the spotlight/karaoke are SVG in foliate's overlayer. A change to any of them must ONLY
// redraw the overlay at the current sentence (via the Reader's onReadingRedraw), never re-inject the
// stylesheet or re-run expand() (which would reflow the whole chapter — RAWY-140). Kept separate from
// GEOMETRY/PAINT precisely so a colour tweak while reading does not move the text under the user.
const TRACK_STYLE_KEYS: (keyof ReadingStyle)[] = [
  "ttsSpotlightOn",
  "ttsSpotlightColor",
  "ttsSpotlightOpacity",
  "ttsSpotlightRule",
  "ttsKaraokeOn",
  "ttsKaraokeColor",
  "ttsKaraokeOpacity",
];
// RAWY-281: the reference twin-rule fields. Same shape as TRACK_STYLE_KEYS and for the same reason —
// they touch neither the injected sheet nor the dynamic paint sheet, so a change is a pure overlayer
// redraw with NO re-inject and NO reflow. That is what makes the settings panel update live: the reader
// drags the slider, `applyStyle` sees only these keys move, and the pair repaints in place.
const REF_STYLE_KEYS: (keyof ReadingStyle)[] = ["refRuleColor", "refRuleWeight", "refRuleOffset"];

export interface RelocateInfo {
  cfi: string | null;
  fraction: number;
  chapterLabel: string | null;
  chapterHref: string | null;
  /**
   * RESILIENCE-1 / WP-4F — WHERE THE READER IS, in foliate's own units.
   *
   * foliate computes all of this on every relocate and Sard used to discard it, which is why the
   * reader had no position readout at all (measured: foliate offered `location 2/129, section 1/15`
   * while the chrome showed nothing).
   *
   * `location` is BYTE-derived, so it is stable under font size, margins, page width, window size
   * and flow mode — the property a page number cannot have in a reflowable book. `pageItem` is the
   * REAL printed page of the source edition and exists only when the book ships a `page-list`.
   */
  location: { current: number; total: number } | null;
  section: { current: number; total: number } | null;
  /** The source edition's own page label, when the book provides one. Never synthesised. */
  pageLabel: string | null;
}

// A flattened table-of-contents entry (RAWY-21 chapters panel).
export interface TocEntry {
  label: string;
  href: string | null;
  level: number;
}

// RAWY-88: one in-book search match. `ahead` = the match lies BEYOND the reader's furthest-read
// position (so spoiler-safe hides its snippet); `frac` (0..1, the match's chapter start) is the
// location readout; the excerpt is split so the panel can bold the `match` inside pre…post.
export interface SearchHit {
  cfi: string;
  sectionIndex: number;
  chapterLabel: string;
  pre: string;
  match: string;
  post: string;
  frac: number;
  ahead: boolean;
}

export interface AnchorRect {
  left: number;
  top: number;
  width: number;
  height: number;
  bottom: number;
}
export interface SelectionInfo {
  cfi: string;
  text: string;
  rect: AnchorRect;
  // RAWY-227: a SNAPSHOT of the selection's DOM range (cloned at capture, so clearing the live selection
  // in the toolbar doesn't invalidate it). Lets listen-from-selection map to the exact TTS unit by DOM
  // position instead of a brittle text match. Optional — a text-match fallback covers its absence.
  range?: Range;
}
export interface AnnotationHit {
  cfi: string;
  rect: AnchorRect;
}

/** What the overlayer actually stores for a mark. NOT `Range` — Sard hands `overlayer.add` the RAWY-258
 *  `wordRectRange` proxy on the normal draw path, and foliate's own fallback `draw` hands it a real Range.
 *  `getClientRects()` is the only thing BOTH provide, so it is the only thing this type promises: typing
 *  this as `Range` is what let `getBoundingClientRect()` past the compiler and into a runtime TypeError. */
type MarkGeometry = { getClientRects: () => ArrayLike<DOMRect> };

/** Anything rect-shaped. `rectInParent` only reads these six numbers, and the union below produces a plain
 *  object rather than a real DOMRect, so the parameter is structural instead of `DOMRect`. */
type RectLike = { left: number; top: number; right: number; bottom: number; width: number; height: number };

/** The union of a mark's painted rects — its bounding box, computed from the ONE accessor every mark
 *  geometry supports. Zero-area rects are skipped (a collapsed range contributes nothing); null when the
 *  mark paints nothing at all, so a caller reports "no anchor" honestly instead of an infinite box. */
function unionRect(rects: ArrayLike<DOMRect>): RectLike | null {
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i];
    if (!(r.width > 0) || !(r.height > 0)) continue;
    if (r.left < left) left = r.left;
    if (r.top < top) top = r.top;
    if (r.right > right) right = r.right;
    if (r.bottom > bottom) bottom = r.bottom;
  }
  if (left === Infinity) return null;
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}

// Fallback highlight palette (used if a theme somehow lacks a slot — matches the design).
const HL_FALLBACK: Record<string, string> = {
  amber: "#E8C36A",
  marigold: "#E7A867",
  coral: "#E2978D",
  rose: "#D285A4",
  purple: "#BFA8D6",
  sky: "#9DC0D6",
  teal: "#8DC3BA",
  green: "#AEC798",
};

// Our own highlight draw function (so we never import from /public): an SVG <g> of
// translucent rects over the selection — the "inked" highlighter look. Elements are
// created in the parent document and adopted when foliate's overlayer appends them.
// RAWY-258 (PART A1) — WORD-SHAPED highlight geometry.
// ROOT (measured): `Range.getClientRects()` returns one rect per LINE BOX, and a line-box rect spans the
// full inline extent — trailing whitespace included — while consecutive line rects tile across the leading
// between them. That is the rectangular block the owner photographed: nothing was adding padding.
// FIX: measure the range WORD BY WORD instead. For each text node inside the range we build EPHEMERAL
// sub-Ranges over the non-whitespace runs and take their client rects. A `Range` is a plain JS object —
// it mutates NOTHING — so every stored CFI (bookmarks RAWY-229, resume RAWY-227, TTS ranges D49, RAWY-247
// units) is untouched. The primitive is already proven twice here: `findMatchRange` and `setReadingWords`.
const WORD_SPLIT = /\S+/g;
function wordRectsFor(range: Range): DOMRect[] {
  const out: DOMRect[] = [];
  const doc = range.startContainer.ownerDocument;
  if (!doc) return out;
  try {
    const walker = doc.createTreeWalker(range.commonAncestorContainer, NodeFilter.SHOW_TEXT);
    let n: Node | null;
    while ((n = walker.nextNode())) {
      const t = n as Text;
      if (!range.intersectsNode(t)) continue;
      // Clip this text node to the part actually inside the range (the first/last nodes are partial).
      const from = t === range.startContainer ? range.startOffset : 0;
      const to = t === range.endContainer ? range.endOffset : t.data.length;
      if (to <= from) continue;
      const slice = t.data.slice(from, to);
      WORD_SPLIT.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = WORD_SPLIT.exec(slice))) {
        const r = doc.createRange();
        try {
          r.setStart(t, from + m.index);
          r.setEnd(t, from + m.index + m[0].length);
        } catch {
          continue; // offsets shifted under us — skip this word rather than throw mid-paint
        }
        for (const rect of Array.from(r.getClientRects())) {
          if (rect.width > 0 && rect.height > 0) out.push(rect); // a word can wrap → more than one rect
        }
      }
    }
  } catch {
    /* fall through — an empty result makes the caller fall back to the line-box rects */
  }
  return out;
}

// RAWY-258: a RANGE-LIKE PROXY handed to foliate's overlayer in place of the real range, so ONLY the
// highlight path gets word geometry. `Overlayer.add()`/`redraw()` call `getClientRects()` on whatever they
// are given, so recomputing here keeps the mark correct across reflow (font load, resize, zoom) exactly like
// a real range. The TTS spotlight keeps the REAL range (line-box rects — its band + baseline rule must stay
// continuous, D49) and the word pill is already word-scoped (RAWY-127): three consumers, separate paths, no
// vendored-engine patch. Falls back to the real rects if word measurement yields nothing.
function wordRectRange(range: Range): { getClientRects: () => DOMRect[]; toString: () => string } {
  return {
    getClientRects: () => {
      const w = mergeIntoStrokes(wordRectsFor(range));
      return w.length ? w : Array.from(range.getClientRects());
    },
    toString: () => range.toString(),
  };
}

// RAWY-258 (owner's visual review): word rects alone were geometrically right and visually WRONG — the eye
// saw "a box per word" before it saw the text. A real highlighter does not stop and restart between words:
// it lays ONE stroke along the line. So the word rects are MERGED back into a single run per line, breaking
// only where a gap is genuinely large (a line end, a wide indent) — which is exactly what the design mockup
// does, since its `.hl` is an inline background with `box-decoration-break: clone`: continuous across each
// line fragment, ending at the last GLYPH rather than running out to the line box. What that kills is the
// real defect — trailing line whitespace, the leading tiled between lines, and empty paragraphs — while an
// ordinary inter-word space stays painted, as it must for the stroke to read as one gesture.
// A gap wider than this many multiples of the line height BREAKS the stroke (a normal space is ~0.25em).
const STROKE_JOIN_RATIO = 0.75;
function mergeIntoStrokes(rects: DOMRect[]): DOMRect[] {
  if (rects.length < 2) return rects;
  // Group by LINE: rects sharing most of their vertical extent belong to the same line fragment.
  const lines: DOMRect[][] = [];
  for (const r of rects) {
    const line = lines.find((l) => {
      const a = l[0];
      const overlap = Math.min(a.bottom, r.bottom) - Math.max(a.top, r.top);
      return overlap > Math.min(a.height, r.height) * 0.5;
    });
    if (line) line.push(r);
    else lines.push([r]);
  }
  const out: DOMRect[] = [];
  for (const line of lines) {
    line.sort((a, b) => a.left - b.left);
    let cur = line[0];
    for (let i = 1; i < line.length; i++) {
      const r = line[i];
      const gap = r.left - cur.right;
      if (gap <= cur.height * STROKE_JOIN_RATIO) {
        // same stroke — extend it over the space between the two words
        const left = Math.min(cur.left, r.left);
        const top = Math.min(cur.top, r.top);
        const right = Math.max(cur.right, r.right);
        const bottom = Math.max(cur.bottom, r.bottom);
        cur = new DOMRect(left, top, right - left, bottom - top);
      } else {
        out.push(cur); // a real break (line end / wide indent) — start a new stroke
        cur = r;
      }
    }
    out.push(cur);
  }
  return out;
}

// RAWY-258 — THE INK SWATCH (docs/design/Sard Highlight Ink Swatch (standalone).html).
// This is the single source of truth for a USER highlight, everywhere one is drawn: saved marks, freshly
// created ones, and the search-hit flash. The TTS tracking overlays (drawReadingSpotlight / drawReadingPill)
// are a DIFFERENT thing serving a different purpose and are deliberately NOT touched by this — see below.
//
// The design is a CSS inline background, and the file states its geometry as "identical everywhere":
//     padding: .05em .2em .09em · margin: 0 -.12em · border-radius: .12em
//     box-decoration-break: clone · mask: 90deg fade, .24em each end
// with two paper treatments:
//     LIGHT — "background: the ink at full value; mix-blend-mode: multiply; colour: page text, unchanged.
//              Pigment sits on the sheet, paper grain shows through."
//     DARK  — "background: ink mixed into the paper, opaque, to a fixed lightness target; no blend mode ·
//              no translucency. A deeper mix of the same ink — never a fainter one."
//
// Sard cannot USE that CSS: it would mean wrapping the highlighted words in a <span>, and inserting elements
// shifts foliate's CFI child-step indices, breaking every stored bookmark (RAWY-229), resume position
// (RAWY-227), TTS range (D49) and RAWY-247 unit. So the recipe is reproduced geometrically in the existing
// SVG overlayer, which mutates nothing. `box-decoration-break: clone` — one painted box per line fragment,
// ending at the last glyph rather than running out to the line box — is exactly what the merged word-runs
// from `mergeIntoStrokes` produce, so the wrapped/multi-line case matches the design by construction.
const INK_EM = 1.15; // a text run's client rect is ~1.15em tall (ascent+descent) — the em basis for the spec
function drawHighlight(
  rects: Iterable<DOMRect>,
  options: { color?: string; dark?: boolean; paper?: string; alpha?: number | null } = {},
): SVGGElement {
  const NS = "http://www.w3.org/2000/svg";
  const g = document.createElementNS(NS, "g");
  const ink = options.color ?? "#E8C36A";
  // RAWY-259: colour, blend and opacity ALL come from the shared resolver (`lib/highlightInk.ts`), which the
  // Notes editor's passage preview calls too — so the mark on the page and the mark in the editor are the
  // same ink BY CONSTRUCTION rather than two styles kept in step by hand. Everything below is unchanged in
  // behaviour; it is the same computation, moved somewhere both surfaces can reach it.
  const resolved = resolveHighlightInk({
    ink,
    dark: options.dark ?? false,
    paper: options.paper,
    alpha: options.alpha,
  });
  const fill = resolved.fill;
  // ⚠️ THE ONE THING THAT MATTERS MOST HERE: READABILITY. The design's ink is a CSS `background` — it paints
  // BEHIND the glyphs, so the file can say "opaque, no translucency" and the text still reads at full
  // contrast on top of it. SARD'S MARK IS NOT BEHIND THE TEXT: foliate's overlayer is an SVG layer ABOVE the
  // content, so the identical values there paint OVER the words and bury them. Copying the file's opacity
  // instruction literally is therefore WRONG in this layer, and the blend mode is what converts an
  // over-the-text overlay back into something that behaves like pigment under it:
  //   LIGHT paper — MULTIPLY. It can only darken, never lighten, so dark glyphs stay dark (black × ink =
  //     black): the text keeps its contrast while the paper around it takes the colour.
  //   DARK paper — SCREEN. It can only lighten, so the light glyphs on a dark page stay light. `normal` here
  //     (which the file's "no blend mode" line literally asks for) paints an opaque slab over the words —
  //     that was the regression: on a dark theme the text was genuinely hidden.
  // The design's INTENT — emphasise the passage, never compete with it — outranks its literal opacity value
  // whenever the two conflict, because in this layer they do.
  g.style.mixBlendMode = resolved.blend;
  g.style.opacity = String(resolved.opacity);
  // The 90deg mask: the run fades in over its first .24em and out over its last .24em, so a stroke begins
  // and ends the way a marker lifts, with no hard vertical edge. Reproduced as alpha stops on the fill
  // (identical result to masking a solid fill, one element instead of two).
  const gradId = `sard-hl-${(hlGradSeq = (hlGradSeq + 1) % 1e6)}`;
  const defs = document.createElementNS(NS, "defs");
  const grad = document.createElementNS(NS, "linearGradient");
  grad.setAttribute("id", gradId);
  grad.setAttribute("x1", "0");
  grad.setAttribute("y1", "0");
  grad.setAttribute("x2", "1");
  grad.setAttribute("y2", "0"); // 90deg — horizontal, per the spec
  defs.append(grad);
  g.append(defs);
  let stopsFor = 0; // the fade is a fixed .24em, so its FRACTION depends on each run's width
  for (const r of rects) {
    if (!(r.width > 0) || !(r.height > 0)) continue; // skip zero-size fragments (hyphen columns etc.)
    const em = r.height / INK_EM;
    // The painted box is the text box grown by the SHARED padding constants — the same figures the Notes
    // editor's preview applies as CSS, so the two shapes cannot drift.
    const x = r.left - em * INK_PAD_X_EM;
    const w = r.width + em * INK_PAD_X_EM * 2;
    const y = r.top - em * INK_PAD_TOP_EM;
    const h = r.height + em * (INK_PAD_TOP_EM + INK_PAD_BOTTOM_EM);
    const rect = document.createElementNS(NS, "rect");
    rect.setAttribute("x", String(x));
    rect.setAttribute("y", String(y));
    rect.setAttribute("width", String(w));
    rect.setAttribute("height", String(h));
    rect.setAttribute("rx", String(em * INK_RADIUS_EM));
    rect.setAttribute("fill", `url(#${gradId})`);
    g.append(rect);
    if (!stopsFor) stopsFor = Math.max(0.04, Math.min(0.5, (em * INK_EDGE_EM) / w));
  }
  // Alpha stops: 0 → opaque at .24em → opaque until .24em from the end → 0.
  const edge = stopsFor || 0.12;
  for (const [offset, op] of [[0, 0], [edge, 1], [1 - edge, 1], [1, 0]] as const) {
    const stop = document.createElementNS(NS, "stop");
    stop.setAttribute("offset", String(offset));
    stop.setAttribute("stop-color", fill);
    stop.setAttribute("stop-opacity", String(op));
    grad.append(stop);
  }
  return g;
}
// A per-group gradient id (an SVG gradient is referenced by id, and several highlights coexist in one
// overlayer). Module-scoped counter — no DOM lookup, no collision across sections.
let hlGradSeq = 0;

// RAWY-126 (TTS reading indicator, Phase 1 — design 1b "Spotlight"): the currently-SPOKEN sentence
// gets a SOFT WARM TRACK — a low-opacity terracotta band + a thin baseline rule the eye follows.
// Deliberately NOT the ink look: no mix-blend-mode (the 8 highlight washes use multiply/screen at
// 0.62/0.70), a much lower fill opacity, and a baseline rule no ink wash has — so it reads as a
// "reading cursor," never as one of the user's saved highlights. Brand terracotta (light) / a
// lighter warm (dark), matching the on-disk design 1b; the solid word "pill" is Phase 2, not here.
// The overlay key is RESERVED (READING_KEY) and the draw goes straight to the section overlayer —
// it never enters the persisted annotations map or the DB.
const READING_KEY = "sard-reading";
function drawReadingSpotlight(rects: Iterable<DOMRect>, options: { dark?: boolean; style?: ReadingStyle } = {}): SVGGElement {
  const NS = "http://www.w3.org/2000/svg";
  const g = document.createElementNS(NS, "g");
  const p = resolveSpotlight(options.style, options.dark ?? false);
  for (const r of rects) {
    if (!(r.width > 0) || !(r.height > 0)) continue; // skip zero-width fragments (e.g. hyphen columns)
    const radius = Math.min(6, r.height * 0.2); // design ~.3em rounded ends, per line fragment
    const ruleH = Math.max(1.5, r.height * 0.08); // design ~.12em baseline rule
    // soft warm band
    const band = document.createElementNS(NS, "rect");
    band.setAttribute("x", String(r.left));
    band.setAttribute("y", String(r.top));
    band.setAttribute("width", String(r.width));
    band.setAttribute("height", String(r.height));
    band.setAttribute("rx", String(radius));
    band.setAttribute("fill", p.fill);
    band.setAttribute("fill-opacity", String(p.band));
    g.append(band);
    // RAWY-200: the thin baseline rule the eye follows — its own on/off control. OFF skips the <rect>
    // entirely (no zero-opacity leftover); the band above still draws. Default (true/undefined) keeps
    // today's look. Read straight off the style so the flag lives with the other track fields.
    if (options.style?.ttsSpotlightRule === false) continue;
    const rule = document.createElementNS(NS, "rect");
    rule.setAttribute("x", String(r.left));
    rule.setAttribute("y", String(r.bottom - ruleH));
    rule.setAttribute("width", String(r.width));
    rule.setAttribute("height", String(ruleH));
    rule.setAttribute("rx", String(Math.min(radius, ruleH / 2)));
    rule.setAttribute("fill", p.fill);
    rule.setAttribute("fill-opacity", String(p.rule));
    g.append(rule);
  }
  return g;
}

// RAWY-127 (TTS reading indicator, Phase 2 — design 1b "pill", EDGE ONLY): the currently-SPOKEN WORD
// inside the sentence track becomes a SOLID terracotta token — an unmistakable moving cursor. Drawn
// as a rounded rect via the overlayer (which sits ABOVE the text), so — unlike the design's inverted
// text (which would need mutating the script-less book iframe, forbidden) — it uses a HIGH-opacity
// terracotta with mix-blend multiply/screen: the word's background reads as a solid pill while the
// glyphs stay legible (black text × terracotta ≈ dark on terracotta). A SECOND reserved key
// (WORD_KEY), added AFTER the band so it paints on top; transient, never the annotations map/DB.
const WORD_KEY = "sard-reading-word";
function drawReadingPill(rects: Iterable<DOMRect>, options: { dark?: boolean; style?: ReadingStyle } = {}): SVGGElement {
  const NS = "http://www.w3.org/2000/svg";
  const g = document.createElementNS(NS, "g");
  const p = resolvePill(options.style, options.dark ?? false);
  g.setAttribute("fill", p.fill);
  g.style.opacity = String(p.op);
  g.style.mixBlendMode = p.blend;
  for (const r of rects) {
    if (!(r.width > 0) || !(r.height > 0)) continue;
    const rect = document.createElementNS(NS, "rect");
    // a touch of horizontal breathing room so the token reads as a pill around the word, not a tight box
    const padX = Math.min(3, r.height * 0.12);
    rect.setAttribute("x", String(r.left - padX));
    rect.setAttribute("y", String(r.top));
    rect.setAttribute("width", String(r.width + padX * 2));
    rect.setAttribute("height", String(r.height));
    rect.setAttribute("rx", String(Math.min(6, r.height * 0.22))); // design ~.28em rounded token
    g.append(rect);
  }
  return g;
}

// RAWY-281 — THE REFERENCE TWIN RULE (docs/design/Sard Reference Twin Rule (standalone).html, variation
// 6a "Equal pair", the file's own recommendation).
//
// WHY THIS IS SVG AND NOT CSS. RAWY-260 drew the reference mark with the CSS Custom Highlight API, whose
// styleable properties are text-only — there is no rounded cap, no second stroke and no controllable gap
// anywhere in that set. The design is explicit that those three things are the point: "a browser's
// `underline double` gives you two hairlines of identical weight, square ends, a fixed sub-pixel gap you
// cannot control … Every variation here is a pair of drawn strokes: rounded terminals, a gap set in em,
// independent weights." So the mark moves to foliate's overlayer, which is the route RAWY-258 already
// established for the highlight ink swatch and for the same non-negotiable reason: an SVG layer mutates
// NOTHING in the book, so foliate's CFI child-step indices are untouched and every stored bookmark,
// resume position, highlight and TTS range keeps resolving. Wrapping the phrase in a <span> — which is
// what the design file's own markup does — is forbidden here (RAWY-229 / RAWY-227 / D49).
//
// THE OVERLAYER SITS ABOVE THE TEXT, AND UNLIKE THE HIGHLIGHT THAT COSTS NOTHING HERE. RAWY-258 needed
// mix-blend-mode because its ink paints OVER the glyphs; the twin rule is drawn entirely BELOW the content
// box, in the leading, where there is nothing to bury. So the design's "colour is the theme accent at
// 100% — no opacity anywhere" is reproduced literally: no blend, no alpha, no compromise. That instruction
// is the whole point of the redesign ("no opacity, which is what kept the old hairline invisible"), and it
// is the one thing the old ground-resolved half-strength colour got wrong.
//
// The run geometry comes from RAWY-258's merged word strokes, which end at the last GLYPH rather than
// running out to the line box — so "both the full width of the word" is exact, and "on wrap, each
// fragment carries the full pair" holds by construction. That step, and the design's own arithmetic,
// live in `refRuleRange` below; this function only paints what it is handed.
// ⚠️ THE RECTS HANDED TO THIS DRAW ARE THE STROKES THEMSELVES, NOT THE TEXT. The geometry is computed in
// `refRuleRange` below, one step earlier than every other draw in this file does it, and that is a
// deliberate correctness choice rather than a stylistic one — see the note there. Here it means the draw
// is a pure translation: one rounded <rect> per incoming rect, cap radius half its height.
function drawRefRule(rects: Iterable<DOMRect>, options: { color?: string } = {}): SVGGElement {
  const NS = "http://www.w3.org/2000/svg";
  const g = document.createElementNS(NS, "g");
  g.setAttribute("fill", options.color ?? "#9C5A3C"); // the theme accent at 100% — no blend, no opacity
  for (const r of rects) {
    if (!(r.width > 0) || !(r.height > 0)) continue;
    const rule = document.createElementNS(NS, "rect");
    rule.setAttribute("x", String(r.left));
    rule.setAttribute("y", String(r.top));
    rule.setAttribute("width", String(r.width));
    rule.setAttribute("height", String(r.height));
    rule.setAttribute("rx", String(r.height / 2)); // "every terminal is a half-round"
    g.append(rule);
  }
  return g;
}

/**
 * RAWY-281: the text's REAL em, in the same pixel space the overlayer draws in, or `null` if it cannot
 * be resolved. See the note at the top of `refRuleRange` for why the obvious `rect.height / INK_EM` is
 * wrong here — measured, it over-reads by 31% on a real Arabic face.
 *
 * TWO conversions, both necessary and neither obvious:
 *  1. `getComputedStyle().fontSize` is the value BEFORE `zoom`; the overlayer's rects are AFTER it. Sard's
 *     reading-size control IS `zoom` (D6) and lands on the book's `body`, so it is always in this chain.
 *  2. `zoom` MULTIPLIES down the tree, so the whole ancestor chain has to be walked, not just the element.
 *     (`getComputedStyle().zoom` reports an element's OWN zoom, not the accumulated one.)
 *
 * Read off the range's START element: a reference phrase is a run of body text, so a mid-phrase font
 * change would be pathological, and the fallback covers it safely rather than pretending to be exact.
 */
function emPxForRange(range: Range): number | null {
  try {
    const node = range.startContainer;
    const el = (node.nodeType === 1 ? node : node.parentElement) as Element | null;
    const win = el?.ownerDocument?.defaultView;
    if (!el || !win) return null;
    let px = parseFloat(win.getComputedStyle(el).fontSize);
    if (!(px > 0)) return null;
    for (let a: Element | null = el; a; a = a.parentElement) {
      const z = parseFloat(win.getComputedStyle(a).zoom || "1");
      if (z > 0 && z !== 1) px *= z;
    }
    return px > 0 ? px : null;
  } catch {
    return null; // a torn-down document — the caller falls back to the rect-height estimate
  }
}

/**
 * RAWY-281: the range-like PROXY handed to the overlayer for a reference mark — the same device RAWY-258
 * introduced (`wordRectRange`), one step further along: it reports the TWO STROKES, not the text.
 *
 * ⚠️ WHY THE GEOMETRY LIVES HERE AND NOT IN THE DRAW. `Overlayer` stores whatever `getClientRects()`
 * returns and uses it for BOTH re-drawing and HIT-TESTING. RAWY-262's double-click-to-edit-a-highlight
 * resolves through `Overlayer.hitTest`, which returns only the TOPMOST overlay at a point and is then
 * gated on `annotations`. Reference marks are added after the highlights, so if this proxy reported the
 * WORD's rects — the obvious thing to do — then a word that is BOTH highlighted and referenced would
 * return the reference key, fail the gate, and the highlight editor would stop opening on it. Reporting
 * the strokes instead means the overlay's hit area is exactly the ink it paints, which sits BELOW the
 * glyphs and therefore cannot shadow anything drawn on them. (Tapping a reference does not go through
 * the overlayer at all — `referenceAtPoint` scans `refRanges` with its own reach-aware slack.)
 *
 * Recomputing from the live range on every call is what keeps the mark correct across reflow (font load,
 * resize, zoom), exactly as a real Range would — the whole reason RAWY-258 used a proxy rather than a
 * snapshot of rects.
 */
function refRuleRange(
  range: Range,
  style: ReadingStyle | null,
  /** The overlayer's own <svg>. Read live (never cached) because paged mode re-sizes it on every
   *  re-render, and a stale height would clamp against a page that no longer exists. */
  svg: SVGSVGElement | null,
): { getClientRects: () => DOMRect[]; toString: () => string } {
  return {
    getClientRects: () => {
      // ⚠️ THE EM BASIS — MEASURED, NOT ASSUMED, AND THE FIRST DRAFT HAD IT WRONG. Every other overlayer
      // draw derives its em as `rect.height / INK_EM` (1.15), i.e. "a text run's client rect is ~1.15em
      // tall". That is a LATIN metric. Measured live in the real app on the owner's Arabic profile, this
      // book's run is **1.507em** tall — so the derived em came out **31% too large**, and since every
      // figure in the design is an em, the whole mark inflated with it (the .30em clearance drew at
      // 12.26px where the design asks for 9.36px). It survived the headless suite because that suite
      // feeds font sizes directly; only the running app has real font metrics.
      //
      // `em` is the FONT SIZE, so the font size is what we read. Two things make that non-obvious:
      // `getComputedStyle().fontSize` is the PRE-zoom value (16px here) while the overlayer draws in
      // post-zoom client space (31.19px here), and Sard's size control IS `zoom` (D6) applied on the
      // book's body — so the zoom chain has to be multiplied back in. INK_EM stays the FALLBACK for the
      // case where no element or no usable font size can be resolved, which keeps a mark on screen
      // rather than dropping it.
      const emPx = emPxForRange(range);
      // RAWY-258's merged word strokes: one run per LINE FRAGMENT, ending at the last GLYPH rather than
      // running out to the line box. That is precisely the design's "both the full width of the word",
      // and it satisfies "on wrap, each fragment carries the full pair" by construction.
      const words = mergeIntoStrokes(wordRectsFor(range));
      const runs = words.length ? words : Array.from(range.getClientRects());
      // The clip's bottom, expressed in the SAME space the rects are in. The overlayer's CTM is a pure
      // TRANSLATION (verified live), so its user-space viewport is simply [0, clientHeight] — which makes
      // the clip bottom the SVG's own height and needs no coordinate conversion. Scrolled mode makes this
      // the whole chapter's height, so the clamp is inert there by construction.
      const clipBottom = svg ? svg.getBoundingClientRect().height || undefined : undefined;
      const out: DOMRect[] = [];
      for (const r of runs) {
        if (!(r.width > 0) || !(r.height > 0)) continue; // zero-size fragments (hyphen columns etc.)
        // The accent is irrelevant here — this proxy answers only "where", never "what colour". The
        // colour is resolved once per section in `drawReferences` and passed to the draw.
        const d = resolveRefRule(style ?? undefined, "", emPx ?? r.height / INK_EM);
        for (const b of refRuleBars(r, d, clipBottom)) out.push(new DOMRect(b.x, b.y, b.width, b.height));
      }
      return out;
    },
    toString: () => range.toString(),
  };
}
// RAWY-281: the overlayer key each reference occurrence is drawn under. RESERVED and prefixed, exactly
// like READING_KEY / WORD_KEY: `highlightAtPoint` resolves an overlayer hit against `this.annotations`
// (the map of stored highlights), and a CFI can never collide with this prefix — so a reference mark can
// never be mistaken for an editable highlight, and these keys never reach `addAnnotation` or the DB.
const REF_KEY_PREFIX = "sard-ref:";

interface OpenOptions {
  resumeCfi?: string | null;
  /** RAWY-85: resume a fixed-layout book (PDF) by fraction — a PDF has a page index, not a CFI. */
  resumeFraction?: number | null;
  style: ReadingStyle;
  theme?: Theme;
  flags?: BookThemeFlags;
  /** Corrected reading direction (a metadata override) — wins over the EPUB's own. */
  dir?: string | null;
  /** Reading flow (RAWY-25): "scrolled" (default) or "paged". */
  flow?: "scrolled" | "paged";
  /** Localized text for the hide-first-line placeholder + reveal (RAWY-70). */
  revealLabels?: RevealLabels;
}

// Arabic combining marks (tashkīl). We wrap runs of them in spans so the diacritics
// toggle can dim/hide them purely via injected CSS (no character removal → text offsets
// stay stable, keeping CFIs valid). RAWY-65: extended with ؐ-ؚ (the Quranic/honorific
// combining marks — e.g. the "peace be upon him" mark — common in classical/religious Arabic
// prose and poetry, which the toggle previously left always-visible regardless of the setting).
const MARKS = "\\u0610-\\u061A\\u064B-\\u065F\\u0670\\u06D6-\\u06DC\\u06DF-\\u06E4\\u06E7\\u06E8\\u06EA-\\u06ED";
const TASHKIL = new RegExp(`[${MARKS}]`);
const TASHKIL_SPLIT = new RegExp(`([${MARKS}]+)`);

function wrapTashkil(doc: Document): void {
  const body = doc.body;
  if (!body || body.dataset?.sardTashkil === "1") return;
  const walker = doc.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  const targets: Text[] = [];
  let n: Node | null;
  while ((n = walker.nextNode())) {
    if (TASHKIL.test((n as Text).data)) targets.push(n as Text);
  }
  for (const tn of targets) {
    const frag = doc.createDocumentFragment();
    for (const part of tn.data.split(TASHKIL_SPLIT)) {
      if (!part) continue;
      if (TASHKIL.test(part)) {
        const span = doc.createElement("span");
        span.className = "sard-tashkil";
        span.textContent = part;
        frag.appendChild(span);
      } else {
        frag.appendChild(doc.createTextNode(part));
      }
    }
    tn.replaceWith(frag);
  }
  if (body.dataset) body.dataset.sardTashkil = "1";
}

// RAWY-67: some converted/scraped EPUBs (common for long serialized web-novel translations) bake
// the chapter heading into the section's own body as a plain paragraph — not a semantic <h1-h6> —
// so the existing hide-chapter-titles rule (which only ever targeted headings) could never catch
// it. Detecting "is this paragraph a title" in general is unreliable (false positives on ordinary
// short prose); instead this is GROUNDED in data we already trust: the book's OWN TOC label for
// this exact section (resolved via the section id, not a stale/racy "last relocate" — `load`
// fires BEFORE the new section's `relocate`, confirmed live, so that shortcut would read the
// PREVIOUS chapter's label at exactly the moment it matters). A section whose TOC label has no
// number is left untouched — fails safe, never over-hides.
const IN_BODY_HEADING_MAX_LEN = 120;

// RAWY-68: RAWY-67 checked only the section's very FIRST text-bearing element and required the
// number at position 0. Real books broke both assumptions — confirmed live on a real 1300+
// chapter Arabic novel: the section has a hidden semantic <h1> ("1026 - <title>") FOLLOWED
// immediately by a second, genuinely visible leading <p> ("الفصل 1026: <title>", with a
// "chapter"-word prefix before the number) — the second element is what the reader actually
// sees, and `startsWith` rejected it outright because it starts with "الفصل", not a digit. Fixed
// generally (no hardcoded word list, any language's "Chapter"/"الفصل"/etc. prefix): the number
// just needs to be the FIRST digit run in the candidate AND appear near the start (a short
// label-word prefix, not a paragraph of prose that happens to mention this exact number deep
// in); and detection now walks MULTIPLE leading elements (not just the first), hiding every
// consecutive one that matches and stopping at the first one that doesn't — that first
// non-match is real body prose starting, and scanning never goes past it.
const MAX_HEADING_NUMBER_PREFIX = 20;
const MAX_LEADING_HEADING_ELEMENTS = 5;

// RAWY-159: a "speakable" TTS unit must carry at least one letter or number. A segment that is only
// punctuation/symbols/whitespace — e.g. a standalone ellipsis "…" / "..." or a lone "—" that
// Intl.Segmenter emits as its OWN sentence (a pause line, common in Arabic prose) — has no speech
// value. Dropping it here, from the shared {text, range} unit list, keeps the spoken queue and the
// spotlight/karaoke ranges index-aligned (both lose the same index together) while making read-aloud
// skip it. lib/tts.ts carries the matching chain-resilience guard so no bad segment can ever stall.
const hasSpeech = (s: string): boolean => /[\p{L}\p{N}]/u.test(s);

// RAWY-247: cap on a spoken UNIT's normalized length. `Intl.Segmenter` sentence granularity breaks only on
// «.»/«؟» (and «!»); it does NOT treat «…»(U+2026) or the Arabic comma «،» as terminators, so an Arabic
// paragraph whose long clauses are joined only by «،»/«…» becomes ONE enormous unit (RAWY-235 measured a
// 318-char unit that failed Edge synthesis 100% of the time). MEASURED across 5 books (749k units): the
// median unit is ~58 chars and the p99 of every WELL-FORMED book is 147–207; 250 sits above all of them and
// below the failing 318, so normal sentences are untouched (Alice +0.00%, الخالد +0.01%, LotM +0.34%,
// Reverend Insanity +0.17% units) and only the long-tail outliers split. Tunable once RAWY-247's live failure
// capture reveals the real Edge threshold.
const MAX_TTS_UNIT_CHARS = 250;
const normLen = (s: string): number => s.replace(/\s+/g, " ").trim().length;
// RAWY-247: closing quotes / sentence-ender set for the "closing quote following a terminator" split rule.
const CLOSE_QUOTE = new Set(["”", "’", "»"]); // ” ’ »
const SENT_END = new Set([".", "؟", "…"]); // . ؟ …

// RAWY-247: choose ONE split BOUNDARY (the char offset AFTER a punctuation) strictly inside (a,b), by
// precedence, nearest the span midpoint. Precedence (WHAT, never mid-word/clause): 1) «…»/«؛»/«;» (pauses);
// 2) «:» or a closing quote right after a sentence-ender; 3) LAST RESORT a comma «،»/«,». Returns -1 if none.
function pickSplit(full: string, a: number, b: number): number {
  const mid = (a + b) / 2;
  const scan = (test: (c: string, i: number) => boolean): number => {
    let best = -1;
    let bd = Infinity;
    for (let i = a; i < b - 1; i++) {
      if (!test(full[i], i)) continue;
      const bpos = i + 1;
      if (bpos <= a || bpos >= b) continue;
      const d = Math.abs(bpos - mid);
      if (d < bd) { bd = d; best = bpos; }
    }
    return best;
  };
  let p = scan((c) => c === "…" || c === "؛" || c === ";");
  if (p >= 0) return p;
  p = scan((c, i) => c === ":" || (CLOSE_QUOTE.has(c) && i > a && SENT_END.has(full[i - 1])));
  if (p >= 0) return p;
  return scan((c) => c === "،" || c === ",");
}

// RAWY-247: subdivide [a,b) into contiguous (tiling) sub-spans each ≤ MAX_TTS_UNIT_CHARS where the
// precedence allows; a span with no safe boundary is left whole (never split mid-word). Recursion stops as
// soon as every piece is under the cap. Under-cap spans return unchanged, so normal prose is untouched.
function splitLongSpan(full: string, a: number, b: number): [number, number][] {
  if (normLen(full.slice(a, b)) <= MAX_TTS_UNIT_CHARS) return [[a, b]];
  const p = pickSplit(full, a, b);
  if (p < 0) return [[a, b]];
  return [...splitLongSpan(full, a, p), ...splitLongSpan(full, p, b)];
}

// RAWY-143: a fold key for comparing a leading line to the section's TOC chapter TITLE. Reuses
// normalizeForSearch (NFKC + strip tashkīl/tatweel + fold alef/ya/teh-marbuta + lowercase + drop
// whitespace) and additionally drops every non-letter/number char (quotes, colons, dots, brackets),
// so "'المبارك' الحقيقي والخيالي." and a bare "المبارك الحقيقي والخيالي" fold to the same key.
function headingKey(s: string): string {
  return normalizeForSearch(s).replace(/[^\p{L}\p{N}]/gu, "");
}

// The TOC label's TITLE portion, keyed: strip a leading "<chapter-word?> <number> <sep>" run
// ("الفصل 322 : ", "Chapter 5 - ", "324 : ") then fold. Empty when the label carries no title text.
function tocTitleKey(tocLabel: string | null): string {
  if (!tocLabel) return "";
  return headingKey(toWesternDigits(tocLabel).replace(/^\D*\d+\s*[:.\-–—·|]*\s*/u, ""));
}

// A candidate line's TITLE portion, keyed: strip an OPTIONAL leading "<number> <sep>" ("323: ") — a
// bare title line (no number, e.g. a split "NNN:" + title heading's second line) folds as-is.
function lineTitleKey(text: string): string {
  return headingKey(toWesternDigits(text).replace(/^\s*\d+\s*[:.\-–—·|]*\s*/u, ""));
}

// RAWY-67/68 + RAWY-143: is a leading block the chapter's heading (safe to hide as the "first line")?
// TWO conservative signals, both GROUNDED in the section's own TOC entry so neither can fire on real
// prose: (1) the line's leading number IS the chapter's TOC number (RAWY-67/68); OR (2) the line, after
// an optional "NNN:" prefix, EXACTLY equals the chapter's TOC title (RAWY-143 — a title-repeat is exactly
// the spoiler this hides; a real first sentence is never verbatim-equal to the short title). (2) catches
// LOTM ch322 (inline number 323 diverges from TOC 322, but the title matches) and ch324 (the title on its
// own line, no number). Both paths keep the ≤120-char length cap. Prefer MISSING a heading over eating text.
function isChapterHeadingCandidate(rawText: string, realNum: number, tocTitle: string): boolean {
  const text = toWesternDigits(rawText).trim();
  if (!text || text.length > IN_BODY_HEADING_MAX_LEN) return false;
  const m = text.match(/\d+/);
  if (m && m.index != null && m.index <= MAX_HEADING_NUMBER_PREFIX && m[0] === String(realNum)) return true;
  if (tocTitle && lineTitleKey(text) === tocTitle) return true;
  return false;
}

// RAWY-68: candidates must be gathered at the BLOCK level (p/h1-h6), not by walking individual
// text nodes — `wrapTashkil` (runs first, on every section) splits any run of Arabic diacritics
// into its own `<span class="sard-tashkil">`, so a single visible heading line like "الفصل 1026:
// أعطيَ ..." is really several sibling text nodes with DIFFERENT immediate parents (the <p>, then
// a tashkil <span>, then the <p> again...). Walking text-node-by-text-node evaluated each tiny
// fragment on its own and broke on the first one (usually a lone diacritic) that didn't match.
// Structural wrapper tags are drilled into (a book's whole chapter is often one <div> holding many
// <p> children — testing the DIV's own aggregate textContent would both fail the length check and
// risk hiding the entire chapter if it ever didn't); true text-leaf tags are tested as one whole
// block via `.textContent`, which already aggregates any nested tashkil spans correctly.
const HEADING_WRAPPER_TAGS = new Set(["DIV", "SECTION", "ARTICLE", "MAIN", "ASIDE"]);

// RAWY-69: semantic headings (h1-h6) are governed exclusively by the "hide chapter title" toggle
// (a plain tag selector in injectedCss.ts) — a heading must never ALSO receive the
// `.sard-chapter-heading` class, or the independent "hide first line" toggle would hide it too,
// even with "hide chapter title" off. It still counts as a matched leading block for the purpose
// of continuing the scan into whatever follows it (e.g. a real book's hidden <h1> immediately
// followed by the genuinely-visible first-line <p> that repeats it) — it just isn't tagged itself.
const HEADING_TAGS = new Set(["H1", "H2", "H3", "H4", "H5", "H6"]);

function collectLeadingBlocks(el: Element, maxCount: number, out: Element[]): void {
  for (const child of Array.from(el.children)) {
    if (out.length >= maxCount) return;
    if (!(child.textContent ?? "").trim()) continue; // skip empty/whitespace-only elements
    // EPUB sections are XHTML parsed as XML (application/xhtml+xml), where tagName preserves the
    // source's case verbatim (lowercase "div", not HTML's uppercased "DIV") — normalize before
    // the Set lookup, or every wrapper check silently misses and this never drills into anything.
    if (HEADING_WRAPPER_TAGS.has(child.tagName.toUpperCase())) collectLeadingBlocks(child, maxCount, out);
    else out.push(child);
  }
}

// Shared with the class's getToc() — one flattening walk over foliate's (possibly nested)
// book.toc, so the free functions below and the public TOC API never drift apart.
function flattenToc(raw: any, level = 0): { label: string; href: string | null; level: number }[] {
  const out: { label: string; href: string | null; level: number }[] = [];
  const walk = (items: any[] | undefined, lvl: number) => {
    if (!Array.isArray(items)) return;
    for (const it of items) {
      out.push({ label: String(it?.label ?? "").trim(), href: it?.href ?? null, level: lvl });
      if (it?.subitems) walk(it.subitems, lvl + 1);
    }
  };
  walk(raw, level);
  return out;
}

/** One fragment-bearing TOC entry inside a section. */
export interface TocSectionEntry {
  href: string;
  label: string;
  fragment: string;
}

/** Where a TOC anchor sits relative to what the reader can currently see. */
export type AnchorPosition = "passed" | "visible" | "ahead" | "missing";

/**
 * RESILIENCE-1 (NAV-2) — the active-entry rule, as a pure function.
 *
 * `locate(fragment)` says where that anchor is relative to the visible range foliate reports on
 * `relocate`: `passed` (behind the reader), `visible` (on screen now), `ahead` (not reached), or
 * `missing` (not in the rendered document).
 *
 * THE RULE, derived from measurement rather than assumed:
 *   1. the FIRST anchor visible on screen — the heading the reader is looking at;
 *   2. else the LAST anchor passed — reading between headings;
 *   3. else the section's first entry — before any anchor, still inside the section it heads.
 *
 * WHY "FIRST VISIBLE" AND NOT "LAST". Two anchors often share one page: Alice's edition line and
 * its "Contents" heading are 182 px apart and always land in the same column. Preferring the LAST
 * visible anchor — which is exactly what foliate's own `TOCProgress` does (progress.js:53) — makes
 * every earlier entry on that page permanently unreachable, which was the reported defect.
 *
 * WHY THE FULL RANGE AND NOT A COLLAPSED START. Measured in paged flow: at page 4 the visible range
 * spans document nodes #47 → #63 while the heading is #62, so the heading sits AFTER the range start
 * even though it is on that very page. Comparing against a collapsed start therefore reported "not
 * reached" for a heading in plain view — the first version of this fix did exactly that and the
 * highlight stuck on entry 0. Scrolled flow hid the error because a TOC jump there scrolls the
 * anchor precisely to the top, so range-start and anchor coincided.
 *
 * WHY `intersectsNode` AND NOT `comparePoint(el, 0)`. The question is "is this heading on screen?",
 * and only intersection answers it. `comparePoint` tests the element's START POINT, so a heading the
 * reader is sitting exactly on reports `-1` — "passed" — because the range begins INSIDE its text.
 * Measured in scrolled flow: clicking the edition-line entry put the range start at offset 30 inside
 * that very heading, which then read as passed, and the next heading down won as "first visible".
 * Intersection has no such boundary case and needs no per-mode correction.
 *
 * Pure ordering logic, no pixels: identical in scrolled and paged flow and in both reading
 * directions, which is why it needs no per-mode special cases.
 */
export function pickActiveTocEntry(
  entries: readonly TocSectionEntry[],
  locate: (fragment: string) => AnchorPosition,
): TocSectionEntry | null {
  if (entries.length === 0) return null;
  let firstVisible: TocSectionEntry | null = null;
  let lastPassed: TocSectionEntry | null = null;
  for (const e of entries) {
    const where = locate(e.fragment);
    if (where === "missing") continue; // not in the rendered document — skip, never assume
    if (where === "visible") {
      if (!firstVisible) firstVisible = e;
    } else if (where === "passed") {
      lastPassed = e;
    } else {
      // Entries are in document order, so once one is ahead of the viewport every later one is too.
      break;
    }
  }
  return firstVisible ?? lastPassed ?? entries[0];
}

function sectionTocLabel(view: any, index: number): string | null {
  const sections = view?.book?.sections;
  const sectionId: string | undefined = sections?.[index]?.id;
  if (!sectionId) return null;
  const flat = flattenToc(view?.book?.toc);
  const hit = flat.find((t) => t.href === sectionId || t.href?.split("#")[0] === sectionId);
  return hit?.label || null;
}

// RAWY-72: the content iframe's top-left in PARENT-viewport coords, so a content-frame pointer
// position (clientX/Y relative to the iframe) can be translated into the same space the window's
// own pointer events use — letting the chrome-on-intent jitter dedup compare both consistently.
function frameOffset(doc: Document): { x: number; y: number } {
  const r = (doc.defaultView as Window & { frameElement?: Element })?.frameElement?.getBoundingClientRect();
  return { x: r?.left ?? 0, y: r?.top ?? 0 };
}

// RAWY-70: build the spoiler-safe placeholder that stands in for a hidden first line. The element
// is purely STRUCTURAL — every visible string is CSS `content` (localized vars, injected by
// buildReadingCss), so a language switch is a re-inject with nothing to rewrite here. The two-step
// reveal is a `data-sard-state` machine driven by clicks the parent frame handles (the content
// iframe has no scripts — RAWY-64 — so the app attaches the listener via cross-frame DOM access,
// exactly like the existing pointer/keydown handlers). CSS shows only the state's relevant bits.
function buildTitlePlaceholder(doc: Document): HTMLElement {
  const ph = doc.createElement("span");
  ph.className = "sard-title-ph";
  ph.setAttribute("data-sard-state", "idle");
  // RAWY-71: NO `dir="auto"` — the placeholder's text is entirely CSS `content` (pseudo-elements),
  // which dir=auto can't see, so it resolved LTR always and reversed the Arabic confirm row. The
  // direction is set explicitly from the UI language via injected CSS (`.sard-title-ph{direction}`).
  const main = doc.createElement("button"); // idle: the tappable "Title hidden"
  main.type = "button";
  main.className = "sard-ph-main";
  const confirm = doc.createElement("span"); // step 2: "Reveal the title?  Reveal  Cancel"
  confirm.className = "sard-ph-confirm";
  const q = doc.createElement("span");
  q.className = "sard-ph-q";
  const yes = doc.createElement("button");
  yes.type = "button";
  yes.className = "sard-ph-yes";
  const no = doc.createElement("button");
  no.type = "button";
  no.className = "sard-ph-no";
  confirm.append(q, yes, no);
  ph.append(main, confirm);
  return ph;
}

// RAWY-253 (root A): STRONG DIRECTIONAL letters only — a letter (\p{L}) of the given script. Excludes
// Arabic punctuation (،؛؟ = neutral), Arabic-Indic DIGITS (weak), and tashkil MARKS (\p{Mn}, not letters) —
// all sit in the Arabic block but are NOT strong-RTL and would wrongly tip the count (a poker line
// "2 ♠، 9 ♥، K ♠." has TWO Arabic commas but ZERO Arabic letters — it must stay LTR). Measured across the
// whole library this cleanly separates every dir="ltr" paragraph (195 pure-Arabic flips in لورد الغوامض,
// 1 in الخالد; 0 near-ties), so the tie-break below never fires in practice but is stated explicitly anyway.
const RE_LETTER = /\p{L}/u;
const RE_ARABIC_SC = /\p{Script=Arabic}/u;
const RE_LATIN_SC = /\p{Script=Latin}/u;
function strongScriptCounts(text: string): { ar: number; lat: number } {
  let ar = 0;
  let lat = 0;
  for (const ch of text) {
    if (!RE_LETTER.test(ch)) continue; // only LETTERS are strong-directional
    if (RE_ARABIC_SC.test(ch)) ar++;
    else if (RE_LATIN_SC.test(ch)) lat++;
  }
  return { ar, lat };
}

// RAWY-253 (root A): in an RTL book, re-assert RTL on paragraphs a conversion tool hardcoded `dir="ltr"`
// although they are overwhelmingly ARABIC (it inferred direction from the first STRONG char — a Latin word
// after a neutral quote — so a 95%-Arabic paragraph was mislabeled LTR, and the attribute overrode Sard's
// injected direction). Add a CLASS (attribute-only → CFI-safe; the DOM is never wrapped/inserted/removed)
// when strong ARABIC letters STRICTLY EXCEED strong Latin letters. TIE-BREAK IS EXPLICIT: equal counts —
// including an empty paragraph (0 == 0) — are LEFT as LTR, so a genuinely-Latin or empty paragraph keeps its
// direction. English/LTR books are a COMPLETE NO-OP (the `dir !== "rtl"` gate). Never touches وMI9/الـMI9
// (that is inside the text, and this only sets a class + CSS direction — it changes no characters).
// RAWY-253 (addendum, owner live-test): DIRECTION and ALIGNMENT are decided SEPARATELY for these paragraphs
// and the split is deliberate — do NOT merge them. A paragraph LEFT as LTR keeps its LTR reading order (or the
// period in “MI9”. moves to the wrong side), but is additionally tagged LTR_ALIGN_CLASS so CSS pulls it onto
// the BOOK's margin — otherwise it aligns to its own LTR start edge and floats to the far side of an
// otherwise right-aligned Arabic page (the owner's screenshot). Empty paragraphs are not tagged (nothing to align).
function markParagraphDirection(doc: Document, dir?: string): void {
  if (dir !== "rtl") return;
  for (const p of Array.from(doc.querySelectorAll<HTMLElement>('p[dir="ltr" i]'))) {
    const text = p.textContent ?? "";
    const { ar, lat } = strongScriptCounts(text);
    if (ar > lat) {
      p.classList.add(FORCE_RTL_CLASS); // Arabic-dominant → flip the base direction back to RTL
      continue;
    }
    // ar <= lat (incl. tie / empty) → KEEP direction:ltr; align visible content to the book's margin.
    if (text.trim()) p.classList.add(LTR_ALIGN_CLASS);
  }
}

// RAWY-253 (root B): scraped/converted EPUBs pad the text with EMPTY (whitespace-only) <p>, each of which
// still takes the reader's per-paragraph margin + line-height × zoom and becomes a large vertical gap
// (لورد الغوامض 55% empty, الخالد 21%). Mark whitespace-only <p> with a CLASS; CSS collapses its box. Skips a
// <p> carrying replaced/embedded content (img/media/hr/table) — that is not padding. Attribute-only →
// CFI-safe; the node is NEVER removed (deletion would shift foliate CFI child-step indices and break stored
// bookmarks/resume). KNOWN LIMIT (owner's live call): a lone blank <p> used DELIBERATELY as a scene break
// collapses too — run length does not distinguish artifact from intent (RAWY-253 measured), only book-level
// density flags it. RTL books only — matches root A's scope and keeps English books completely untouched.
function markEmptyParagraphs(doc: Document, dir?: string): void {
  if (dir !== "rtl") return;
  for (const p of Array.from(doc.querySelectorAll<HTMLElement>("p"))) {
    if ((p.textContent ?? "").trim()) continue; // has text → not empty
    if (p.querySelector("img, svg, picture, video, audio, iframe, object, canvas, hr, input, table")) continue; // replaced content → keep
    p.classList.add(EMPTY_P_CLASS);
  }
}

function markInBodyHeading(doc: Document, tocLabel: string | null): void {
  const body = doc.body;
  if (!body || body.dataset?.sardHeadingScanned === "1") return;
  if (body.dataset) body.dataset.sardHeadingScanned = "1";
  const realNum = extractChapterNumber(tocLabel);
  if (realNum == null) return; // no number to ground the match against — don't guess (safety boundary)
  const tocTitle = tocTitleKey(tocLabel); // RAWY-143: the TOC title key for the title-match fallback
  const blocks: Element[] = [];
  collectLeadingBlocks(body, MAX_LEADING_HEADING_ELEMENTS, blocks);
  for (const el of blocks) {
    if (!isChapterHeadingCandidate(el.textContent ?? "", realNum, tocTitle)) break; // real prose starts here — stop
    if (HEADING_TAGS.has(el.tagName.toUpperCase())) continue; // a real heading — the title toggle owns it
    el.classList.add("sard-chapter-heading");
    // RAWY-70: put a placeholder immediately before the line so the reveal handler can find the
    // line as `ph.nextElementSibling`. It's inert (CSS `display:none`) until hideFirstLine is on.
    el.insertAdjacentElement("beforebegin", buildTitlePlaceholder(doc));
  }
}

// RAWY-134 (A): a "…"-only scene-break line (neutral bidi chars — dots, asterisks, dashes, bullets)
// aligns LEFT in an RTL book when the line carries dir="auto": auto/plaintext direction falls back to
// LTR for a paragraph with NO strong-directional character, overriding the book's inherited RTL base
// (Sard already injects `direction:rtl` for RTL books, but a per-line dir="auto" wins — confirmed in
// the engine: `dir=auto` + "…" resolves LTR, and even unicode-bidi:plaintext can't rescue it). A neutral
// line WITHOUT dir="auto" correctly inherits RTL. So, in an RTL book only, force short neutral-only leaf
// lines to the book direction so they align RIGHT with the surrounding text. Strong-typed lines (Arabic
// OR Latin) keep their own inferred direction; text-align is left untouched, so an intentionally centered
// or otherwise book-aligned break is preserved — only the default-neutral case is corrected.
// RAWY-195: find the blocks the BOOK deliberately aligns, and tag them so the reader's forced
// alignment / paragraph spacing / indent spare them. Without this, hardening text-align (which is what
// makes the control work at all on a book with its own CSS) would also flatten every centred poem,
// scene break, figure and title page to the user's body-text alignment.
//
// The measurement has to happen BEFORE our own alignment rule can apply, or we would just read our own
// value back. That's what the `.sard-al` gate is for: buildReadingCss scopes the forced alignment to
// `:root:root.sard-al`, this pass runs while <html> still lacks the class (so what computes is the
// book's own alignment, inherited exactly as the book intended), and the class goes on at the end.
// It runs inside foliate's `afterLoad`, before the section is rendered — so there is no flash.
//
// DIRECTION-AWARE (the subtlety that makes it safe): `text-align: right` is NOT a deliberate flourish
// in an RTL book — it is just the start edge, and Lord of the Mysteries declares it on nearly every
// block (`.calibre4{text-align:right}`, plus `body{text-align:right!important}`). Treating that as "the
// book meant it" would exempt the whole book and the alignment control would go on doing nothing. So
// only CENTRE, and the edge OPPOSITE the reading direction, count as intent. `start` (the initial value
// — i.e. nothing was ever said) and `justify` never do.
//
// SCOPE TODAY: Sard does not currently apply an EPUB's external stylesheet at all (RAWY-195 measured
// this; see OPEN.md), so a book's centring declared in a .css file cannot reach here yet. What this
// pass DOES catch today is centring that does not go through a stylesheet — an inline
// `style="text-align:center"` and the `[align=center]`/`<center>` presentational hints. It is also the
// guard that keeps the book's centred poetry intact the day that stylesheet defect is fixed, at which
// point the hardened !important alignment above would otherwise flatten every centred block.
function markBookAlignedBlocks(doc: Document, dir?: string): void {
  const root = doc.documentElement;
  if (!root) return;
  try {
    const win = doc.defaultView;
    if (!win) return;
    const rtl = dir === "rtl";
    const opposite = rtl ? "left" : "right"; // the edge away from where the text starts
    // foliate measures with the frame briefly displayed (a display:none iframe can't be trusted for
    // computed style in every engine); do the same so this pass can't silently read nothing.
    const frame = win.frameElement as HTMLElement | null;
    const hidden = frame?.style.display === "none";
    if (frame && hidden) frame.style.display = "block";
    // Two passes: read EVERY computed value first, tag second. Adding a class invalidates style for
    // that subtree, so interleaving the two would force a fresh style resolve on each read.
    const blocks = doc.querySelectorAll<HTMLElement>("p, li, blockquote, div, td, th, dd, dt");
    const keep: HTMLElement[] = [];
    for (const el of blocks) {
      const ta = win.getComputedStyle(el).textAlign;
      if (ta === "center" || ta === "-webkit-center" || ta === "end" || ta === opposite) keep.push(el);
    }
    if (frame && hidden) frame.style.display = "none";
    for (const el of keep) el.classList.add(BOOK_ALIGN_CLASS);
  } finally {
    // Always open the gate — a book that somehow threw above must still get the user's alignment,
    // rather than silently losing the control altogether.
    root.classList.add(ALIGN_GATE_CLASS);
  }
}

function alignNeutralLines(doc: Document, dir?: string): void {
  if (dir !== "rtl") return; // LTR books: a neutral line falling to the left is already correct
  const STRONG = /\p{L}/u; // any letter → a strong-directional line; leave it to the bidi algorithm
  const blocks = doc.querySelectorAll<HTMLElement>("p, div, li, blockquote, h1, h2, h3, h4, h5, h6");
  for (const el of blocks) {
    if (el.getAttribute("dir") === "rtl") continue; // already correct
    const t = (el.textContent ?? "").trim();
    if (!t || t.length > 16 || STRONG.test(t)) continue; // empty / a long container / has real text → skip
    el.setAttribute("dir", "rtl"); // a short neutral-only line → follow the book's RTL direction
  }
}

async function ensureFoliateDefined(): Promise<void> {
  if (customElements.get("foliate-view")) return;
  await new Promise<void>((resolve, reject) => {
    const ready = () => customElements.whenDefined("foliate-view").then(() => resolve());
    const existing = document.querySelector<HTMLScriptElement>("script[data-foliate]");
    if (existing) return ready();
    const s = document.createElement("script");
    s.type = "module";
    s.src = "/foliate-js/view.js";
    s.dataset.foliate = "1";
    s.onload = ready;
    s.onerror = () => reject(new Error("Failed to load /foliate-js/view.js"));
    document.head.appendChild(s);
  });
}

// Chapter-boundary scroll gesture (RAWY-25; tuned RAWY-26). A wheel gap longer than this
// starts a NEW gesture: a single continuous burst that reaches the chapter end STOPS there,
// and only a fresh gesture (after this pause) advances to the next chapter. ⬅ TUNE HERE if the
// boundary feels too heavy/light. 140 ms (RAWY-26, down from 220): still well above the gap
// between wheel events inside one continuous scroll (~16–80 ms), so same-gesture chaining is
// still blocked, but a deliberate second flick advances more readily (lighter).
const BOUNDARY_PAUSE_MS = 140;
const BOUNDARY_EDGE_PX = 4;
// RAWY-250: how close to a section's top still counts as "entered at the beginning" (scrolled flow). A
// natural advance / TOC click / resume-at-top lands at exactly 0; a mid-chapter jump lands hundreds of px in.
// Deliberately small — this gate exists to keep a mid-chapter jump from marking a chapter read.
const CHAPTER_START_SLACK_PX = 24;
// RAWY-260: a few px of slack around a reference mark. The indicator is an underline drawn BELOW the
// glyph box, so a tap aimed at the visible line can fall just outside the range rect; this makes the
// target the word plus its underline without ever reaching a neighbouring line.
const REF_HIT_SLACK_PX = 4;
// RAWY-73/75: wheel travel (accumulated px) that constitutes a deliberate scroll intent — now
// ASYMMETRIC (RAWY-75). Hiding on scroll-down stays near-immediate (any real notch ≈ 100–120px
// clears 24). Showing on scroll-up needs a CLEAR, deliberate gesture: one notch is a light nudge
// the owner found annoying, so the show threshold is ~2–3 notches of accumulated upward travel.
const SCROLL_HIDE_PX = 24;
const SCROLL_SHOW_PX = 240;
// A pause longer than this starts a NEW wheel gesture: the intent accumulator resets, so slow
// scattered nudges minutes apart can never add up to a "deliberate" scroll-up.
const SCROLL_GESTURE_GAP_MS = 400;
// RAWY-128: while TTS plays, the auto scroll-follow (RAWY-126) used to yank the spoken sentence back
// into view on every sentence advance — fighting the user's manual scroll (a tug every few seconds
// that read as "heaviness"). Suppress the follow for this window after any manual WHEEL so scrolling
// is free; the spotlight/pill still track the audio, and the gentle follow resumes once the user
// settles. ⬅ TUNE HERE if follow resumes too eagerly/slowly after a manual scroll.
const FOLLOW_SUPPRESS_MS = 1200;

// RAWY-86: normalize text for a best-effort, Arabic-aware in-PDF find. Folds the differences that
// commonly separate a typed query from an embedded PDF text layer WHEN that layer is otherwise clean
// (logical order, real Unicode): NFKC collapses Arabic Presentation Forms/ligatures to base letters;
// tashkil (harakat) and tatweel are stripped; alef/ya/teh-marbuta variants are folded; case is
// lowered; and ALL whitespace is dropped so a query still matches a text layer that emits one glyph
// per item. It deliberately does NOT try to undo VISUALLY-REORDERED (reversed) glyph runs — some
// Arabic PDFs embed subset fonts with a missing/broken ToUnicode CMap and expose garbage no reader can
// reliably reconstruct; those simply won't match (reported honestly, not faked).
const TASHKIL_TATWEEL = /[ـً-ْٰۖ-ۭ]/g;
function normalizeForSearch(s: string): string {
  return s
    .normalize("NFKC")
    .replace(TASHKIL_TATWEEL, "")
    .replace(/[آأإٱ]/g, "ا") // آأإٱ → ا
    .replace(/ى/g, "ي") // ى → ي
    .replace(/ة/g, "ه") // ة → ه
    .toLowerCase()
    .replace(/\s+/g, ""); // drop all whitespace (rescues one-glyph-per-item text layers)
}

// RAWY-178 (AUD-13): findMatchRange normalises the rendered chapter ONE CHARACTER AT A TIME, so a big
// chapter ran normalizeForSearch (NFKC + 5 regex + lowercase) hundreds of thousands of times per hit-
// jump — a visible hitch. A book uses only a few hundred DISTINCT characters, so memoise the per-char
// result: the heavy normalisation runs once per distinct char instead of once per occurrence. The loop
// keeps its exact per-source-char index→(node,offset) mapping, so the computed Range is IDENTICAL.
const NORM_CHAR_CACHE = new Map<string, string>();
function normChar(ch: string): string {
  let v = NORM_CHAR_CACHE.get(ch);
  if (v === undefined) {
    v = normalizeForSearch(ch);
    NORM_CHAR_CACHE.set(ch, v);
  }
  return v;
}

// RAWY-139: locate a search hit's TEXT in the RENDERED section doc and return a Range on it. A search
// CFI is computed on foliate's raw `createDocument()`, but the rendered doc's structure differs (the
// RAWY-70 hide-first-line placeholder is inserted, etc.), so the CFI's element/offset can point at the
// wrong (shorter) node → `CFI.toRange` throws and the gold flash is silently skipped. The excerpt's
// pre/match/post is exact, so we re-find it here, tolerantly: normalise both sides (drop whitespace +
// tashkil, RAWY-88's `normalizeForSearch`) so diacritics/spacing can't defeat the match, using the
// pre/post context to pick the right occurrence, then map the normalised hit back to a real DOM Range.
function findMatchRange(doc: Document, pre: string, match: string, post: string): Range | null {
  const m = match ?? "";
  if (!m) return null;
  const preW = (pre ?? "").slice(-40); // a context window keeps the needle unique without being unwieldy
  const postW = (post ?? "").slice(0, 40);
  const needle = normalizeForSearch(preW + m + postW);
  const matchStart = normalizeForSearch(preW).length;
  const matchLen = normalizeForSearch(m).length;
  if (!needle || !matchLen) return null;
  // Normalised concatenation of the section's text, with every normalised char mapped back to its
  // source (text node + offset) so we can rebuild a real Range from a normalised index.
  let norm = "";
  const nodes: Text[] = [];
  const offs: number[] = [];
  try {
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
    let n: Node | null;
    while ((n = walker.nextNode())) {
      const t = n as Text;
      const s = t.data;
      for (let i = 0; i < s.length; i++) {
        const nc = normChar(s[i]); // memoised (RAWY-178/AUD-13); 0 chars (whitespace/tashkil), 1, or more
        for (let k = 0; k < nc.length; k++) { norm += nc[k]; nodes.push(t); offs.push(i); }
      }
    }
  } catch {
    return null;
  }
  const idx = norm.indexOf(needle);
  if (idx < 0) return null;
  const start = idx + matchStart;
  const endIdx = start + matchLen;
  if (start >= nodes.length) return null;
  try {
    const range = doc.createRange();
    range.setStart(nodes[start], offs[start]);
    if (endIdx < nodes.length) range.setEnd(nodes[endIdx], offs[endIdx]);
    else { const last = nodes[nodes.length - 1]; range.setEnd(last, last.data.length); }
    return range.collapsed ? null : range;
  } catch {
    return null;
  }
}

// RAWY-182: process the chapter walk in CHUNKS of this many containers, yielding to the event loop
// between chunks so queued input (e.g. the TTS shrink-button click) is handled and no single task hogs
// the main thread. `breathe()` yields a macrotask so a pending click runs before the next chunk.
const UNITS_CHUNK = 24;
const breathe = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

// RESILIENCE-1 / WP-7 (stage 3) — INSTALL THE SANITISER HOOK, ONCE, AT MODULE LOAD.
//
// The vendored engine reads `globalThis.__sardSanitiseBookCss` at the top of `replaceCSS` (local
// patch 5). Installing it here rather than per-open means there is no window in which a stylesheet
// could be processed with no hook present, and the mode it applies is a module-level value the
// Reader updates — so a setting change takes effect on the next book without re-installing anything.
//
// It starts at `off`, the shipping default. Until stage 4 opens the CSP no book stylesheet reaches
// the frame at all, so this hook is currently reached only by sheets that are already inert — which
// is exactly the property stage 3 must preserve and byte-identity is asked to prove.
let bookCssMode: BookCssMode = "off";

/** Set the mode future stylesheets are sanitised with. Called by the Reader from the stored setting. */
export function setBookCssMode(mode: BookCssMode): void {
  bookCssMode = mode;
}

/**
 * DIAGNOSTIC BUILD ONLY. Publishes the tracking-unit section so `lib/diag.ts` can compare it against
 * the displayed section. Writes to a window field and, when the collector is armed, records an
 * event. Deliberately dependency-free and failure-proof: a diagnostic must never alter or break the
 * pipeline it observes.
 */
/** DIAGNOSTIC BUILD ONLY: record why the reading-follow refused to act for sentence `i`. */
function diagFollow(i: number, reason: string, data: Record<string, unknown>): void {
  try {
    diagNote("tts.follow", "MEASURED", `follow SKIPPED for sentence ${i}: ${reason}`, { sentenceIndex: i, reason, ...data });
  } catch {
    /* never let instrumentation affect playback */
  }
}

function publishDiagUnits(section: number, unitCount: number, displayed: number | null): void {
  try {
    // The snapshot the collector takes later reads this section number; `diagNote` records the moment
    // it changed. Both go through lib/diag, which a release build aliases away — the pair used to
    // reach for `globalThis.__sardDiag*` directly, and a global back-channel is invisible to the
    // bundler, so it survived into release bundles that were supposed to have no instrumentation.
    diagPublishUnits(section, unitCount, displayed);
    diagNote("tts.units", "MEASURED", `tracking units built: ${unitCount} for section ${section}`, {
      ttsUnitsSectionIndex: section,
      displayedSectionIndex: displayed,
      unitCount,
      sectionsMatch: displayed === section,
      note: displayed === section ? "sections agree — the draw gate can pass" : "SECTIONS DISAGREE — the draw gate will refuse",
    });
  } catch {
    /* never let instrumentation affect playback */
  }
}

if (typeof globalThis !== "undefined") {
  (globalThis as unknown as { __sardSanitiseBookCss?: (css: string) => string }).__sardSanitiseBookCss =
    (css: string) => sanitiseBookCss(css, bookCssMode);
}

export class FoliateController {
  private view: any | null = null;
  private style: ReadingStyle | null = null;
  private theme: Theme | undefined = undefined;
  private flags: BookThemeFlags = { overrideBookColor: false, hideChapterTitles: false, hideFirstLine: false };
  private revealLabels: RevealLabels | undefined = undefined; // RAWY-70: placeholder/reveal strings
  private forcedDir: string | undefined = undefined; // corrected direction (RAWY-19)
  private relocateCb: ((info: RelocateInfo) => void) | null = null;
  // Highlights (RAWY-20): cfi → semantic colour slot; re-applied per section render.
  private annotations = new Map<string, string>();
  // RAWY-259: each highlight’s OWN ink density, keyed by the same CFI as `annotations`. Absent = follow
  // the theme default (every highlight made before the feature), so the map stays empty until a reader
  // actually sets a density and nothing about the untouched case changes.
  private hlAlpha = new Map<string, number>();
  // RAWY-126 (TTS reading indicator): the current chapter walked ONCE into {text, range} units — the
  // SAME order + SAME hidden-skip that feeds the TTS queue, so queue-index N ↔ range N stay aligned.
  // `ttsUnitsIndex` is the section index these were built for (a chapter change invalidates them).
  private ttsUnits: { text: string; range: Range | null }[] = [];
  private ttsUnitsIndex = -1;
  private ttsLang: string | undefined = undefined; // RAWY-129: lang the units were built with (for a rebuild)
  // RAWY-129 (A): fired after the reading chapter's overlay is (re)created — the Reader re-draws the
  // spotlight/pill at the current index, so returning to a still-playing chapter restores the track.
  private readingRedrawCb: (() => void) | null = null;
  // RAWY-127 (word karaoke): sub-ranges of the current sentence, one per Edge word (null = unmapped),
  // rebuilt each time a sentence with word timing starts (in lockstep with the Reader's index effect).
  private wordRanges: (Range | null)[] = [];
  private selectionCb: ((sel: SelectionInfo | null) => void) | null = null;
  private showCb: ((hit: AnnotationHit) => void) | null = null;
  private contentDoc: Document | null = null; // RAWY-122: the current section doc (for clearSelection)
  // RAWY-132: the content selection's text as it stood at the last content pointerdown. A plain click
  // INSIDE an existing selection doesn't collapse it on mousedown — the browser defers the collapse for
  // a possible drag-drop, so the pointerup still sees the old range and would re-raise the toolbar (the
  // RAWY-122 "re-fires on the next tap" bug). If the selection is unchanged across the gesture, it's a
  // dismiss, not a new selection: we clear it instead of re-firing. (Empty when nothing was selected.)
  private downSelText = "";
  // RAWY-72: forward pointer activity happening INSIDE the content iframe (which never reaches a
  // parent-window listener) so the chrome-on-intent hook can wake the auto-hiding bar. Coords are
  // translated to parent-viewport space so the hook's jitter dedup shares one coordinate system.
  private activityCb: ((x: number, y: number, isTap: boolean) => void) | null = null;
  // RAWY-180 (Part B): Space inside the reading frame — if a read-aloud session is active this toggles
  // play/pause (the cb returns true → we swallow the key); otherwise Space keeps its normal behaviour
  // (scroll the EPUB / page the PDF). The content frame's keydown never reaches the parent window, so
  // this callback is how the parent's TTS toggle runs from reading-area focus.
  private spaceCb: (() => boolean) | null = null;
  // RAWY-184 (Part C): Left/Right arrow inside the reading frame — if a read-aloud session is active this
  // skips the previous/next SENTENCE (the cb returns true → swallow the key); otherwise arrows keep their
  // normal reader behaviour (page turn). Same reasoning as `spaceCb`: the content frame's keydown never
  // reaches the parent window, so this callback runs the parent's sentence-skip from reading-area focus.
  private arrowCb: ((key: string) => boolean) | null = null;
  // RAWY-73: scroll intent (scrolled mode) — accumulate wheel delta and fire a debounced direction
  // so a small jitter doesn't toggle the bar. down = scroll down (hide), up = scroll up (show).
  private scrollIntentCb: ((down: boolean) => void) | null = null;
  private scrollAccum = 0;
  private scrollIntentTs = 0; // RAWY-75: last wheel time — a long gap resets the accumulator
  private lastUserScrollTs = 0; // RAWY-128: last MANUAL wheel — TTS auto-follow yields for a moment after
  // Scrolled mode + chapter-boundary gesture state (RAWY-25).
  private scrolledMode = false;
  private wheelTs = 0;
  private gestureEdge: "top" | "bottom" | null = null;
  private gestureActed = false;

  // RAWY-88: in-book search + spoiler-safe boundary. `furthestCfi` = the FURTHEST-read position (per
  // the design: not the page currently open — flipping back to re-read never un-hides results); it
  // only advances (via epubcfi.compare). `cfiCompareFn` is the vendored engine's CFI comparator,
  // loaded once per open (runtime dynamic import — Vite can't statically import /public).
  private furthestCfi: string | null = null;
  private cfiCompareFn: ((a: string, b: string) => number) | null = null;

  /** Tear down the current view + listeners. Safe to call repeatedly. */
  dispose(): void {
    const v = this.view;
    this.view = null;
    this.annotations.clear();
    // RAWY-FINAL: release everything that holds a reference INTO a section document, so closing a book
    // (or switching one) cannot pin the outgoing book's DOM. `refRanges` holds Ranges; `contentDoc` /
    // `pdfPageDoc` hold whole Documents. All three are re-established by the next `load` event.
    //
    // DELIBERATELY NOT CLEARED: `ttsUnits` / `ttsUnitsIndex` / `wordRanges`. `open()` calls `dispose()`
    // first, and a FLOW-MODE change (Reader.tsx `update`) re-opens the same book while read-aloud may be
    // playing — the `create-overlay` handler relies on `ttsUnitsIndex >= 0` surviving that re-open to
    // rebuild the units and restore the reading spotlight (RAWY-129 A). Clearing them here would be a
    // behaviour change, not a leak fix; they are bounded (one chapter) and replaced on the next build.
    this.refRanges.clear();
    this.prevRefKeys.clear(); // RAWY-281: paint bookkeeping follows the ranges (strings only — never a leak)
    this.contentDoc = null;
    this.pdfPageDoc = null;
    // RAWY-295: the layer observer holds a node inside the outgoing page document. VENDOR patch 9
    // exists because two ResizeObservers were left watching detached nodes and emitted a silent
    // per-frame error storm; `disconnect()` needs no reference to what it observed, so it cannot be
    // wrong about which element to release or be skipped by a guard that happens to be false.
    this.pdfLayerObserver?.disconnect();
    this.pdfLayerObserver = null;
    this.pdfHighlightIndex = null;
    if (v) {
      try {
        v.close?.();
      } catch {
        /* ignore */
      }
      v.remove?.();
    }
  }

  /**
   * RAWY-286: FINAL teardown — `dispose()` plus the read-aloud ranges it deliberately keeps.
   *
   * WHY THIS IS SEPARATE FROM `dispose()`. `dispose()` is called from TWO places with OPPOSITE
   * requirements, and that is the whole reason the leak existed:
   *   • `open()` calls it to swap the view. The RAWY-129 (A) `create-overlay` handler then relies on
   *     `ttsUnitsIndex >= 0` SURVIVING, so a flow-mode change that re-opens the SAME book while
   *     read-aloud plays can rebuild the units against the fresh doc and restore the spotlight.
   *     Clearing there would be a behaviour regression, which is why the fields are kept.
   *   • The Reader's unmount / book-change cleanup calls it to LEAVE the book. Nothing is coming
   *     back, and keeping the ranges here is pure retention.
   *
   * MEASURED (RAWY-286, real release build, heap snapshot with retainer paths): after leaving a book
   * that had read-aloud running, ONE `Range` per retained unit still pointed into that chapter's
   * document, giving the retainer chain
   *     Range -> .range -> [i] -> elements -> `ttsUnits` -> FoliateController -> ctrlRef.current
   * and the same shape via `wordRanges`. A `Range` keeps its `Text` node, therefore its ancestors and
   * its owner `Document`, alive — so each book listened to pinned one detached chapter document
   * (~7,000 nodes, ~5 MB). Cycling open -> Listen -> back measured +2 Documents, +1 Frame, ~+7,000
   * Nodes and ~+6 MB PER CYCLE, with a natural control (a cycle whose Listen never started grew by
   * exactly zero) and two isolating runs (book switching alone: 0 drift; repeated read-aloud inside
   * ONE book: 0 drift). The cost appears only at the intersection, which is precisely this exit path.
   *
   * The controller instance itself is retained past unmount by other holders (the module-level
   * annotations/references stores keep the `ctrl` they were bound to). That is a separate, far
   * cheaper question — a bare object rather than a document — and is deliberately NOT addressed here.
   * Clearing the ranges releases the DOM whether or not the controller is collected.
   */
  destroy(): void {
    this.dispose();
    this.synthToc = null; // WP-6A: belongs to the view that was just torn down
    this.ttsUnits = [];
    this.ttsUnitsIndex = -1;
    this.wordRanges = [];
  }

  /** Open `source` into `container`. Idempotent — disposes any prior view first. */
  async open(source: string, container: HTMLElement, opts: OpenOptions): Promise<void> {
    this.dispose();
    await ensureFoliateDefined();

    const view = document.createElement("foliate-view") as any;
    this.view = view; // claim ownership before awaits; a later open() will replace this
    container.replaceChildren(view);

    // DIAGNOSTIC BUILD ONLY — stages 5-7. `view.open()` is where the book is fetched, the format is
    // detected and the format module is dynamically imported. The previous report could see the
    // fetch but nothing after it, because a dynamic-import rejection never reaches `window.fetch`.
    // Catching it HERE gives the real exception and stack; it is rethrown untouched so behaviour is
    // identical to the uninstrumented build.
    diagStageEnter("controller.open", { source: String(source).slice(0, 200), isPdf: /\.pdf(\?|$)/i.test(String(source)) });
    // DIAGNOSTIC BUILD ONLY — START THE RENDERING LEDGER FOR *THIS* BOOK.
    //
    // `renderDiagReset()` existed but was never called from anywhere, so one ledger described a whole
    // session and carried two defects into every report:
    //
    //   1. STALE REASONS. Opening a PDF marks stages 2-14 NOT OBSERVABLE with "this book is a PDF".
    //      Opening an EPUB afterwards moves their STATE on, but `meta.reason` is only ever assigned
    //      into, never cleared — so the report told the next investigator "this book is a PDF" about
    //      an EPUB, and any stage the EPUB did not re-enter stayed NOT OBSERVABLE for that reason.
    //   2. SESSION-SPAN DURATIONS. The ledger's `t0` was set when the module loaded, so every stage
    //      timestamp was "milliseconds since the app started". A tester who opens the failing book
    //      ten minutes in produced a ledger where every stage read ~600000 ms and nothing could be
    //      told from anything else.
    //
    // Resetting HERE — at the first stage of an open, before anything is recorded — makes the ledger
    // describe one book, which is the only thing it was ever able to describe honestly.
    renderDiagReset();
    renderDiagSurface(container); // DIAGNOSTIC BUILD ONLY — the surface the black-page autopsy walks
    rStageOk("open.requested", { source: String(source).slice(0, 200), format: /\.pdf(\?|$)/i.test(String(source)) ? "pdf" : "epub" });
    try {
      await view.open(source);
      diagStageOk("controller.open", { bookLoaded: !!view.book, sections: view.book?.sections?.length ?? null });
      diagStageOk("book.make", { format: view.book?.rendition?.layout ?? "unknown", hasSections: !!view.book?.sections });
      diagStageOk("open.requested", { outcome: "the open call returned without throwing" });
      // DIAGNOSTIC BUILD ONLY — the same moment, told from the RENDERING pipeline's point of view.
      // The metadata/spine facts are read from the opened book, never assumed.
      rStageOk("book.opened", {
        title: String(view.book?.metadata?.title ?? "(none)").slice(0, 80),
        sections: view.book?.sections?.length ?? null,
        layout: view.book?.rendition?.layout ?? "unknown",
        hasMetadata: !!view.book?.metadata,
      });
      const toc = view.book?.toc;
      if (Array.isArray(toc) && toc.length) rStageOk("nav.loaded", { tocEntries: toc.length, source: "book.toc" });
      else if (view.book?.sections?.length) rStageOk("nav.loaded", { tocEntries: 0, source: "spine only — the book declares no navigation" });
      else rStageFail("nav.loaded", new Error("the book exposes neither a TOC nor a spine"), {});
      // A PDF renders to a canvas. Watch for one so that a WORKING machine reports stages 12-13 as
      // completed — otherwise every report would show them NOT ENTERED and there would be no way to
      // tell a healthy pipeline from a broken one.
      if (/\.pdf(\?|$)/i.test(String(source))) {
        void diagWatchFirstPage(container);
        renderDiagNotEpub("this book is a PDF — the EPUB rendering pipeline does not run for it; see the PDF ledger above");
      }
    } catch (e) {
      diagStageFail("controller.open", e, { source: String(source).slice(0, 200) });
      rStageFail("book.opened", e, { source: String(source).slice(0, 200) }); // DIAGNOSTIC BUILD ONLY
      void diagProbeChain("view.open() threw");
      throw e;
    }
    if (this.view !== view) return; // superseded by a newer open()

    // Reading flow (RAWY-25): scrolled is the default. Set BEFORE the first section lays out
    // so foliate computes the right (scrolled vs columnised) layout from the start.
    // RAWY-86: a PDF is FIXED-LAYOUT — its own renderer (foliate-fxl) paginates by spread and has
    // no scrolled flow, so it is always PAGED (the scrolled-mode wheel/flow attr don't apply — that
    // was why RAWY-85's PDF was stuck: no chevrons + a scroll no-op).
    const fxl = this.isFixedLayout;
    this.scrolledMode = !fxl && opts.flow !== "paged";
    if (!fxl) view.renderer.setAttribute("flow", this.scrolledMode ? "scrolled" : "paginated");

    // RAWY-88: seed the spoiler-safe boundary at the resume position + load the CFI comparator (EPUB
    // only — a PDF has no CFI/whole-book text search). Done before reading starts so relocate can
    // advance `furthestCfi` synchronously.
    this.furthestCfi = fxl ? null : (opts.resumeCfi ?? null);
    if (!fxl) await this.ensureCfiCompare();
    if (this.view !== view) return; // superseded during the await

    // RAWY-19: a corrected direction (override) wins over the EPUB's page-progression so a
    // mistagged book (e.g. an Arabic book tagged ltr) reads + pages RTL once fixed.
    // RESILIENCE-1 (NAV-2): the per-section TOC grouping belongs to THIS book — clear it on open,
    // or a cross-book follow would refine the new book against the old book's table of contents.
    this.tocBySection = null;
    this.requestedTocHref = null; // a navigation intent belongs to the book it was made in
    this.forcedDir = opts.dir ?? undefined;
    if (this.forcedDir && view.book) view.book.dir = this.forcedDir;

    view.addEventListener("relocate", (e: any) => {
      let fraction = typeof e.detail?.fraction === "number" ? e.detail.fraction : 0;
      // foliate-view puts the section (= PDF page) index at detail.section.current, NOT detail.index.
      const pageIdx = e.detail?.section?.current;
      if (fxl && typeof pageIdx === "number") {
        this.pdfPageIndex = pageIdx; // RAWY-86 (drives in-PDF find's start page + page readout)
        // RAWY-86: a PDF page (fixed-layout spread) has no in-section fraction, so foliate reports the
        // section BOUNDARY fraction (page i → (i+1)/n). Its own inverse `getSection()` then rounds a
        // boundary UP to the next section, so resuming that value lands one page too far. Persist the
        // section MIDPOINT instead — `getSection((i+0.5)/n) === i` — so resume returns to the exact page.
        const n = this.pdfPageCount;
        if (n > 0) fraction = (pageIdx + 0.5) / n;
      }
      // RAWY-88: advance the furthest-read boundary (never retreat — re-reading earlier never un-hides
      // spoiler-safe results). EPUB only; the comparator is preloaded so this stays synchronous.
      const cfi = e.detail?.cfi ?? null;
      if (!fxl && cfi) {
        if (!this.furthestCfi || (this.cfiCompareFn?.(cfi, this.furthestCfi) ?? 0) > 0) this.furthestCfi = cfi;
      }
      // RESILIENCE-1 (NAV-2): refine WHICH TOC entry the reader is inside when a section holds more
      // than one. See `refineTocEntry` — foliate's own answer is kept verbatim for every other book.
      const sectionIndex = e.detail?.section?.current;
      const refined = fxl ? null : this.refineTocEntry(sectionIndex, e.detail?.range);
      // RESILIENCE-1 (NAV-3): a section no TOC entry points at — a cover or a full-page
      // illustration. foliate reports nothing for it, which left the page belonging to no entry at
      // all. Only consulted when foliate itself has no answer, so no book that HAS an entry for its
      // section is affected.
      const orphan =
        !fxl && !refined && !e.detail?.tocItem && typeof sectionIndex === "number"
          ? this.firstTocEntryAfterSection(sectionIndex)
          : null;
      const chosen = refined ?? orphan;
      // WP-4F: carry foliate's own position through instead of dropping it. `location.current` can
      // be 0-based or absent depending on the book, so it is only published when it is a real number
      // and the total is positive — a readout that says "0 of 0" is worse than no readout.
      const loc = e.detail?.location;
      const sec = e.detail?.section;
      const usable = (v: unknown): v is { current: number; total: number } =>
        !!v && typeof (v as { current: unknown }).current === "number" &&
        typeof (v as { total: unknown }).total === "number" && (v as { total: number }).total > 0;
      this.relocateCb?.({
        cfi,
        fraction,
        chapterLabel: chosen?.label ?? e.detail?.tocItem?.label ?? null,
        chapterHref: chosen?.href ?? e.detail?.tocItem?.href ?? null,
        location: usable(loc) ? { current: loc.current, total: loc.total } : null,
        section: usable(sec) ? { current: sec.current, total: sec.total } : null,
        pageLabel: e.detail?.pageItem?.label != null ? String(e.detail.pageItem.label) : null,
      });
    });
    view.addEventListener("load", (e: any) => {
      const doc: Document | undefined = e.detail?.doc;
      const index: number = e.detail?.index ?? 0;
      // DIAGNOSTIC BUILD ONLY — record the section's own facts (body present, text length, its
      // stylesheets, its layout box) BEFORE any of our own processing touches the document, so the
      // report describes the book as it arrived rather than as we left it. Wrapped: a diagnostic must
      // never be able to break the render it is observing.
      //
      // NOT for a PDF page. A pdf.js page is a canvas plus a text layer, so it has no meaningful body
      // content size and no text nodes laid out the way an EPUB's are — measured: feeding PDF pages
      // to this ledger reported "layout completed: FAILED" and "no visible text" for a PDF that was
      // rendering perfectly. PDFs have their own ledger; this one is only about EPUB rendering.
      if (!fxl) {
        try {
          renderDiagAdoptDoc(doc, index, view.book?.sections?.[index]?.id ?? undefined);
        } catch {
          /* observation only */
        }
      }
      // DIAGNOSTIC BUILD ONLY — the export shortcut must work while a book is open. Focus lives in
      // this document once the book is open, and its key events never reach the top-level window, so
      // the listener has to be here too. EPUB and PDF alike: a PDF is what the tester came to report.
      try {
        diagAttachDocument(doc);
      } catch {
        /* observation only */
      }
      if (!doc) return;
      // RAWY-86: a PDF page is a rendered image + a pdf.js text layer — none of the EPUB-content
      // machinery (tashkīl wrapping, in-body heading marking, the reveal, boundary-scroll) applies.
      // Capture the page doc (for copy) + keep arrow-key paging + chrome-wake activity; skip the rest.
      if (fxl) {
        this.pdfPageDoc = doc;
        if (this.pdfTheme) this.setPdfTheme(this.pdfTheme.filter, this.pdfTheme.tint); // RAWY-294
        // RAWY-295: a page turn is a NEW document, so the previous page's highlight cannot leak here —
        // there is nothing to clear. What is needed is the reverse: the units belong to the page on
        // screen, so the highlight is re-derived for THIS page, and the layer is watched for the
        // rebuild a zoom causes. `readingRedrawCb` re-reads the live index from the TTS store, which is
        // the same route RAWY-129 already uses after a section is recreated.
        this.pdfWatchLayer(doc);
        if (this.pdfHighlightIndex != null) this.readingRedrawCb?.();
        doc.addEventListener("keydown", (ev: KeyboardEvent) => {
          // RAWY-180 (Part B): Space toggles read-aloud when active; else it pages the PDF (as before).
          if (ev.key === " ") { if (this.spaceCb?.()) ev.preventDefault(); else this.view?.next?.(); }
          // WP-4C: the same single owner the EPUB path uses (see handleNavKey).
          else if (this.handleNavKey(ev.key)) ev.preventDefault();
        });
        // RAWY-87 (#2): a wheel over the PDF PAGE fires INSIDE this iframe, so it never reaches the
        // reader-desk's onWheel (the frame boundary) — that's why wheeling the page did nothing while
        // the margins (which DO reach the desk → pageByWheel) turned pages. Forward the page's own
        // wheel to the SAME pageByWheel path, so a wheel anywhere in the reading area pages the PDF.
        // The two paths are mutually exclusive per physical wheel (page XOR margin), so no double-turn;
        // the page is fit-to-view (no native scroll to fight), so this is passive with no preventDefault.
        // RAWY-291: Ctrl+Wheel (and a trackpad pinch, which arrives as exactly that) must ZOOM here
        // rather than page, matching the desk's handler. `passive: false` only for the zoom case, so
        // the browser's own page-zoom does not also fire; plain paging stays passive as before.
        doc.addEventListener("wheel", (ev: WheelEvent) => {
          if (ev.ctrlKey || ev.metaKey) { ev.preventDefault(); this.zoomIntentCb?.(ev.deltaY); return; }
          // RAWY-293: a wheel over the page must scroll the ZOOMED page first (layer 1), so the
          // in-frame path and the desk path share one behaviour. deltaX rides along for wide pages.
          ev.preventDefault();
          this.pageByWheel(ev.deltaY, ev.deltaX);
        }, { passive: false });
        doc.addEventListener("pointerdown", (ev: PointerEvent) => {
          if (this.activityCb) {
            const off = frameOffset(doc);
            this.activityCb(ev.clientX + off.x, ev.clientY + off.y, true);
          }
        });
        return;
      }
      this.contentDoc = doc; // RAWY-122: kept so clearSelection() can drop a lingering text selection
      wrapTashkil(doc); // enable the diacritics toggle for this section
      this.writeFonts(doc); // RAWY-208: this section's @font-face sheet — survives every setStyles
      this.writeDynamic(doc); // RAWY-140: this section's in-place PAINT sheet (colour/tashkīl skip re-inject)
      markInBodyHeading(doc, sectionTocLabel(view, index)); // RAWY-67: hide-titles catches this too
      // RAWY-195: measure the book's OWN alignment and open the alignment gate. Must run before
      // anything paints, and before alignNeutralLines (which sets dir=, not text-align, but keep the
      // pristine document for the measurement anyway).
      markBookAlignedBlocks(doc, this.dir);
      alignNeutralLines(doc, this.dir); // RAWY-134 (A): "…"-only scene breaks follow the book's RTL side
      markParagraphDirection(doc, this.dir); // RAWY-253 (root A): RTL-correct paragraphs mislabeled dir="ltr"
      markEmptyParagraphs(doc, this.dir); // RAWY-253 (root B): collapse scrape-padding empty <p>
      // RAWY-260: mark this section's reference occurrences. Runs ONCE per section render, over this
      // section's own text — the book is never rescanned, so the cost is independent of its length.
      this.applyReferences(doc, index);
      // RAWY-70: the two-step reveal for the hide-first-line placeholder. Handled from the parent
      // frame (the content iframe runs no scripts, RAWY-64) via cross-frame DOM access, like the
      // handlers below. Per-instance + reset-on-navigation is automatic: each section is a fresh
      // doc with a fresh idle placeholder.
      doc.addEventListener("click", (ev: Event) => this.onRevealClick(ev));
      // RAWY-260: a tap on a marked phrase opens its reference. Hit-tests the ranges already stored for
      // this section, so it costs a few rect comparisons — never a re-scan — and ignores taps elsewhere.
      doc.addEventListener("click", (ev: Event) => {
        const e = ev as MouseEvent;
        // Pass the click in the CONTENT document's own coordinates — the space Range.getClientRects()
        // reports in. (This previously added the frame offset first, which put the point in parent space
        // and made the comparison meaningless; referenceAtPoint converts the MATCHED rect instead.)
        const hit = this.referenceAtPoint(doc, e.clientX, e.clientY);
        // A tap that lands on a reference is a request to see it, not a page interaction — don't let it
        // also raise the selection toolbar or dismiss anything else.
        if (hit) {
          ev.stopPropagation();
          this.referenceCb?.(hit);
        }
      });
      // RAWY-262 (UX EXPERIMENT): a DOUBLE-click inside an existing highlight opens its editor.
      // Same SHAPE as the reference hit-test above — hit-test a registry that already exists, in the
      // content doc's own coordinate space, convert the matched rect to parent space at the END — but
      // it reuses the overlayer's OWN hitTest rather than a second rect loop, because highlights (unlike
      // references) already have a registry: the overlayer foliate draws them from. That is the same
      // code path foliate's single click used, so the hit area is EXACTLY the painted mark, multi-line
      // highlights hit per line fragment, and adjacent highlights stay distinct — for free, with no new
      // state to keep in sync and nothing added to the EPUB DOM.
      doc.addEventListener("dblclick", (ev: Event) => {
        const e = ev as MouseEvent;
        // The body is wrapped because an exception thrown from a DOM listener is swallowed silently by
        // the page, and release builds have DevTools disabled — that is exactly how the original
        // RAWY-262 defect hid. The guard is KEPT (a throw here must not abort the gesture pipeline);
        // only the RAWY-FINAL-removed probe instrumentation is gone.
        try {
          const hit = this.highlightAtPoint(doc, e.clientX, e.clientY);
          // Not on a highlight → the gesture is untouched, so double-click-to-select-a-word over plain
          // text keeps working exactly as it does today. The editor gesture is claimed ONLY over a mark.
          if (!hit) return;
          // The second mousedown already word-selected under the cursor, and pointerup raised the
          // selection toolbar for it. Inside a highlight this gesture belongs to EDITING, so retract both
          // BEFORE surfacing the hit — otherwise the toolbar and the editor would be up at once.
          ev.preventDefault();
          ev.stopPropagation();
          this.clearSelection();
          this.selectionCb?.(null);
          this.showCb?.(hit);
        } catch {
          /* a throw here must not break reading — the gesture is simply not claimed */
        }
      });
      doc.addEventListener("keydown", (ev: KeyboardEvent) => {
        // RAWY-184 (Part C): while read-aloud is active, arrows skip the prev/next SENTENCE (the cb
        // returns true → swallow); otherwise they keep the normal page-turn (next/prev).
        // WP-4C: routed through the ONE owner (handleNavKey) so a key behaves identically whether
        // focus is inside the book or up in the chrome.
        if (ev.key === "ArrowLeft" || ev.key === "ArrowRight") { if (this.handleNavKey(ev.key)) ev.preventDefault(); }
        // RAWY-180 (Part B): Space toggles read-aloud when a session is active; otherwise it keeps its
        // normal behaviour (scrolling the content). Only swallow the key when the toggle actually fired.
        else if (ev.key === " ") { if (this.spaceCb?.()) ev.preventDefault(); }
        // RAWY-122: Esc while reading dismisses a just-made selection + its popover, and clears the
        // real text selection so it can't re-fire (the reading frame has focus, so its own Esc is here).
        else if (ev.key === "Escape") {
          this.clearSelection();
          this.selectionCb?.(null);
        }
        // RAWY-136: F11 must toggle fullscreen from ANYWHERE, including with focus inside the book.
        // The content iframe is a separate frame, so its keydown does NOT bubble to the parent `window`
        // where App.tsx's fullscreen toggle listens — F11 "only worked from the app chrome". This
        // listener runs in the parent context (cross-frame DOM), so re-dispatch the key on the parent
        // window and App.tsx's single toggle (which owns the enter/exit state) handles it. preventDefault
        // stops the iframe's own F11 default first.
        else if (ev.key === "F11") {
          ev.preventDefault();
          window.dispatchEvent(new KeyboardEvent("keydown", { key: "F11" }));
        }
        // RAWY-196: Ctrl/Cmd+F (and "/") must reach SARD's in-book search — never the WebView2 find
        // bar. Exactly the RAWY-136 problem above, and its cause: Reader.tsx DOES bind Ctrl+F (RAWY-88)
        // but it listens on the PARENT window, while a reader's focus is inside this content iframe —
        // so the key never reached Sard, nothing called preventDefault, and Chromium opened its own
        // find bar over the book. Forward it like F11.
        //
        // Match on `ev.code`, NEVER `ev.key`: `code` is the PHYSICAL key, `key` is what the layout
        // produces. On the owner's ARABIC keyboard the F key yields "ب", so the old `key === "f"` test
        // could never fire — Ctrl+F was doubly broken for him (RAWY-196 audit). Same for "/" (that key
        // is "ظ" on an Arabic layout), hence `code === "Slash"`.
        else if ((ev.ctrlKey || ev.metaKey) && ev.code === "KeyF") {
          ev.preventDefault();
          window.dispatchEvent(
            new KeyboardEvent("keydown", { key: "f", code: "KeyF", ctrlKey: true }),
          );
        } else if (ev.code === "Slash" && !ev.ctrlKey && !ev.metaKey && !ev.altKey && !ev.shiftKey) {
          ev.preventDefault();
          window.dispatchEvent(new KeyboardEvent("keydown", { key: "/", code: "Slash" }));
        }
      });
      // The section's ONE wheel entry point. It was registered only in scrolled mode, for the
      // chapter-boundary "new gesture to advance" handler (RAWY-25) — which is scrolled-only and still
      // is: `onBoundaryWheel` returns early when `!scrolledMode`.
      //
      // It is now registered in BOTH flows because Ctrl+Wheel zoom answers before that guard, and a
      // zoom that works while scrolling and not while paging is not a feature. MEASURED: with the old
      // condition, a trusted Ctrl+Wheel over the text in paged mode reached the content document and
      // changed nothing — no listener was there to hear it. Non-passive is required (the handler calls
      // preventDefault) and costs nothing in paged, where this document has no native scroll to block.
      doc.addEventListener("wheel", (ev: WheelEvent) => this.onBoundaryWheel(ev), { passive: false });
      // RAWY-72: wake the auto-hiding chrome on pointer activity over the reading content. A move is
      // throttled (~8/s) since the hook only needs to know "the pointer moved"; both move + tap are
      // translated to parent-viewport coords for the hook's shared jitter dedup.
      let lastMoveFwd = 0;
      doc.addEventListener(
        "pointermove",
        (ev: PointerEvent) => {
          if (!this.activityCb) return;
          const now = performance.now();
          if (now - lastMoveFwd < 120) return;
          lastMoveFwd = now;
          const off = frameOffset(doc);
          this.activityCb(ev.clientX + off.x, ev.clientY + off.y, false);
        },
        { passive: true },
      );
      // Selection → in-context toolbar (RAWY-20). Also a tap → wake the chrome (RAWY-72).
      doc.addEventListener("pointerdown", (ev: PointerEvent) => {
        this.selectionCb?.(null);
        // RAWY-132: remember the selection as the gesture starts, so pointerup can tell a fresh
        // drag-select from a plain click inside a lingering selection (see below + downSelText).
        this.downSelText = doc.getSelection()?.toString() ?? "";
        if (this.activityCb) {
          const off = frameOffset(doc);
          this.activityCb(ev.clientX + off.x, ev.clientY + off.y, true);
        }
      });
      doc.addEventListener("pointerup", () => {
        const sel = doc.getSelection();
        if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
        const text = sel.toString().trim();
        if (!text) return;
        // RAWY-132 INVARIANT: a click that does NOT change the selection is a dismiss, never a raise.
        // Clicking inside an existing selection defers the browser's collapse (drag-drop candidate), so
        // getSelection() still reports the old range here — raising the toolbar again is the RAWY-122
        // "re-fires on the next tap" regression (made reachable during TTS by the reading band, whose
        // overlay covers the reading text). Only a gesture that actually produced a NEW selection (drag
        // or double-click-a-word → different text) reaches the raise; an unchanged one clears for real.
        if (sel.toString() === this.downSelText) {
          this.clearSelection();
          this.selectionCb?.(null);
          return;
        }
        const range = sel.getRangeAt(0);
        let cfi: string;
        try {
          cfi = view.getCFI(index, range);
        } catch {
          return;
        }
        this.selectionCb?.({ cfi, text, rect: this.rectInParent(range.getBoundingClientRect(), doc), range: range.cloneRange() });
      });
    });

    // Highlights: draw on (re)render, re-apply per section, surface clicks (RAWY-20).
    view.addEventListener("draw-annotation", (e: any) => {
      const { draw, annotation, doc: aDoc, range } = e.detail;
      // RAWY-259: this mark's OWN ink density, if the reader set one; otherwise undefined so drawHighlight
      // falls back to the theme default and an untouched highlight renders exactly as it always has.
      const opts = {
        color: this.resolveColor(annotation.color),
        dark: this.theme?.dark ?? false,
        paper: this.inkPaper,
        alpha: this.hlAlpha.get(annotation.value),
      };
      // RAWY-258 (PART A1): draw the mark from WORD rects, not the line-box rects foliate's own `draw`
      // helper would produce. `draw` closes over the real range, so we bypass it and call the SAME
      // `overlayer.add` it would have called, handing over the range-PROXY instead (view.js already gives
      // us `range` + `doc` in the event detail, and Sard already adds to the overlayer directly in
      // `goToSearchHit` — so this is an existing path, not a new one, and the engine is NOT patched).
      // Any failure falls back to foliate's own `draw`, so a highlight can never silently vanish.
      const overlayer = aDoc
        ? (this.view?.renderer?.getContents?.() as { doc?: Document; overlayer?: { add?: (k: string, r: unknown, d: unknown, o: unknown) => void } }[] | undefined)
            ?.find((x) => x.doc === aDoc)?.overlayer
        : undefined;
      if (range && overlayer?.add) {
        try {
          overlayer.add(annotation.value, wordRectRange(range as Range), drawHighlight, opts);
          return;
        } catch {
          /* fall through to foliate's own draw */
        }
      }
      draw(drawHighlight, opts);
    });
    // RAWY-262 (UX EXPERIMENT): a SINGLE click is NEVER an edit. This event is foliate's own click
    // hit-test, and forwarding it is what used to throw the editor open the instant a reader tapped a
    // mark mid-reading — including on an accidental tap. The edit gesture moved to the dblclick handler
    // above, so this no longer surfaces an annotation hit at all.
    //
    // Every key the overlayer can return now takes ONE path — real highlights, the transient TTS reading
    // indicators (sard-reading / sard-reading-word, RAWY-126) and the RAWY-249 search flash alike — so
    // nothing here has to tell them apart any more, and the RAWY-132 bogus-active bug it used to guard
    // against is unreachable by construction rather than by a name check.
    view.addEventListener("show-annotation", () => {
      // RAWY-132 tap-dismiss, kept: a tap on a mark still clears a stray selection so a later pointerup
      // can't re-raise the toolbar. RAWY-230 (§2b), kept: only a COLLAPSED/absent selection is dismissed —
      // a live NON-collapsed selection survives, so a drag that ENDS on a highlight (or on the spoken
      // sentence's band) raises the toolbar exactly as it does over plain text. Net effect: a single click
      // on a highlight is now indistinguishable from a single click on ordinary text.
      const sel = this.contentDoc?.getSelection?.();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
        this.clearSelection();
        this.selectionCb?.(null);
      }
    });
    view.addEventListener("create-overlay", (e: any) => {
      for (const [cfi, color] of this.annotations) view.addAnnotation({ value: cfi, color });
      // RAWY-281: the FIRST paint of this section's reference marks. `applyReferences` already ran (from
      // `load`) and stored the ranges, but the overlayer did not exist yet — foliate dispatches
      // create-overlayer only after `await view.load()`. This is that second half; it is also what
      // restores the marks when a section is re-rendered after navigating away and back.
      //
      // ⚠️ THE MICROTASK IS LOAD-BEARING, AND LEAVING IT OUT SHIPPED A REAL BUG THAT ONLY LIVE DRIVING
      // FOUND. `create-overlay` is emitted from INSIDE `#createOverlayer` (view.js:418) and the overlayer
      // it returns is attached to the view by the CALLER, on the next line — so during this handler
      // `getContents()[…].overlayer` is still UNDEFINED and a synchronous draw silently finds nothing.
      // Measured: the opening section painted (a later `applyTheme` redrew it by luck) and then EVERY
      // section navigated to afterwards had ZERO marks — 0 groups across sections 850-857, in a book
      // whose referenced word appears in all of them.
      //
      // Deferring by one microtask is exactly enough: `attach` runs synchronously right after the emit
      // returns, so the stack unwinds with the overlayer in place. This is also WHY the neighbouring
      // annotation redraw above never had the bug — `view.addAnnotation` is async and awaits its CFI
      // resolution, which pushes it past the same boundary for free.
      const idx = e.detail?.index;
      if (typeof idx === "number") queueMicrotask(() => this.drawReferences(idx));
      // RAWY-129 (A): the reading track (spotlight/pill) is drawn from Range objects tied to a section's
      // doc; navigating away destroys that doc, so on RETURN the ranges are stale (0 client rects) and the
      // overlay never comes back on its own (nothing re-fires the draw). When the TTS chapter's overlay is
      // (re)created, rebuild its units against the FRESH doc and ask the Reader to redraw at the current
      // sentence — so returning to a still-playing chapter restores the track wherever the audio now is.
      if (this.ttsLang != null && this.ttsUnitsIndex >= 0 && e.detail?.index === this.ttsUnitsIndex) {
        // RAWY-182: the rebuild is now async/chunked (non-blocking); redraw once the fresh ranges are ready.
        void this.getChapterUnits(this.ttsLang).then(() => this.readingRedrawCb?.());
      }
    });

    this.style = opts.style;
    if (opts.theme) this.theme = opts.theme;
    if (opts.flags) this.flags = opts.flags;
    if (opts.revealLabels) this.revealLabels = opts.revealLabels;
    this.reinject();

    if (opts.resumeCfi) await view.goTo(opts.resumeCfi);
    // RAWY-85: a PDF resumes by fraction (no CFI) — jump to the saved page.
    else if (opts.resumeFraction != null && opts.resumeFraction > 0) await view.goToFraction(opts.resumeFraction);
    else if (this.scrolledMode) await view.goToFraction(0); // start at the top of section 0
    else await view.renderer.next();
  }

  /** Re-inject the full stylesheet (typography + theme) — the single visual funnel. RAWY-140: this
   *  path re-declares @font-face and re-runs foliate's expand() (a column re-layout), so it is used
   *  ONLY for genuine geometry changes; colour/tashkīl go through the in-place dynamic sheet below. */
  private reinject(): void {
    if (this.style) {
      const css = buildReadingCss(this.style, this.theme, this.flags, this.dir, this.revealLabels);
      this.view?.renderer?.setStyles?.(css);
      // DIAGNOSTIC BUILD ONLY — stages 9 and 10. "Changing the theme has no effect" is one of the
      // reported symptoms, so the report must be able to show whether the theme actually reached the
      // document: which sheet was written, how long it was, and the colours inside it.
      try {
        rStageOk("css.injected", { typographySheetChars: css.length, appliedVia: "renderer.setStyles" });
        renderDiagTheme(String((this.theme as any)?.id ?? "(unknown)"), String((this.theme as any)?.mode ?? "(unknown)"), css);
      } catch {
        /* observation only */
      }
    }
  }

  // RAWY-140: (re)write the PAINT sheet for one content doc. Appended AFTER foliate's own <style> (so
  // it wins the forced ink) and updated in place — a style recalc/repaint, never setStyles, so a
  // colour/tashkīl change causes no @font-face re-resolve (FOUT flash) and no expand() (the jump).
  private writeDynamic(doc: Document | undefined): void {
    if (!this.style || !doc?.head) return;
    let el = doc.head.querySelector<HTMLStyleElement>(`style[${DYN_ATTR}]`);
    if (!el) {
      el = doc.createElement("style");
      el.setAttribute(DYN_ATTR, "");
      doc.head.append(el); // last in <head> → beats foliate's sheet for the forced ink
    }
    el.textContent = buildDynamicCss(this.style, this.theme, this.flags);
    // DIAGNOSTIC BUILD ONLY — the PAINT sheet is the one that carries the ink and page colour, so it
    // is the sheet that matters most to a black page. Recorded per document, wrapped.
    try {
      rStageOk("theme.applied", {
        paintSheetChars: el.textContent.length,
        themeId: String((this.theme as any)?.id ?? "(unknown)"),
        writtenInto: "the section document's own <style>",
      });
      renderDiagTheme(String((this.theme as any)?.id ?? "(unknown)"), String((this.theme as any)?.mode ?? "(unknown)"), el.textContent);
    } catch {
      /* observation only */
    }
  }

  // RAWY-208: (re)write the @font-face sheet for one content doc. Written ONCE per doc at section load
  // and thereafter only on a real font change — never on a geometry change, which is the whole point:
  // the faces must survive setStyles untouched so the engine keeps them and never falls back.
  // Order in <head> is irrelevant here (@font-face declares a face, it does not compete in the cascade),
  // but it is PREPENDED so the faces are declared before foliate's sheet references them.
  private writeFonts(doc: Document | undefined): void {
    if (!this.style || !doc?.head) return;
    let el = doc.head.querySelector<HTMLStyleElement>(`style[${FONT_ATTR}]`);
    if (!el) {
      el = doc.createElement("style");
      el.setAttribute(FONT_ATTR, "");
      doc.head.prepend(el);
    }
    const next = buildFontFaceCss(this.style);
    // Never rewrite identical text: assigning textContent re-parses the sheet, which would drop and
    // re-fetch the faces — exactly the bug this split exists to remove.
    if (el.textContent !== next) el.textContent = next;
  }

  /** RAWY-208: push the @font-face sheet to every loaded content doc (only on a real font change). */
  private applyFonts(): void {
    const contents = this.view?.renderer?.getContents?.() as { doc?: Document }[] | undefined;
    if (!contents) return;
    for (const c of contents) this.writeFonts(c?.doc);
  }

  /** RAWY-140: push the current PAINT sheet to every loaded content doc, in place (no reflow). */
  private applyDynamic(): void {
    const contents = this.view?.renderer?.getContents?.() as { doc?: Document }[] | undefined;
    if (!contents) return;
    for (const c of contents) this.writeDynamic(c?.doc);
  }

  /** RAWY-70: update the hide-first-line placeholder/reveal strings (UI-language change) + re-inject. */
  setRevealLabels(labels: RevealLabels): void {
    this.revealLabels = labels;
    this.reinject();
  }

  // RAWY-70: two-step reveal of a hidden first line. The placeholder sits immediately before its
  // line (`ph.nextElementSibling`), so revealing = tag that line `.sard-revealed` (excluded from
  // the hide rule) and mark the placeholder "revealed" (CSS collapses it). Only the placeholder's
  // own controls are ever the target here — a click anywhere else in the book is ignored.
  private onRevealClick(ev: Event): void {
    const target = ev.target as Element | null;
    const ph = target?.closest?.(".sard-title-ph") as HTMLElement | null;
    if (!ph) return;
    ev.preventDefault();
    if (target!.closest(".sard-ph-yes")) {
      ph.setAttribute("data-sard-state", "revealed");
      const line = ph.nextElementSibling;
      if (line?.classList.contains("sard-chapter-heading")) line.classList.add("sard-revealed");
    } else if (target!.closest(".sard-ph-no")) {
      ph.setAttribute("data-sard-state", "idle");
    } else if (target!.closest(".sard-ph-main")) {
      ph.setAttribute("data-sard-state", "confirm");
    }
  }

  /** Update typography (size/font/spacing/margins/align/diacritics). RAWY-140: a change that only
   *  touches PAINT (font colour, tashkīl) is pushed through the in-book dynamic <style> with no
   *  reflow; a GEOMETRY change (fonts/size/spacing/align/flow) still re-injects the full sheet
   *  (which re-lays-out — inherent). A chrome-only change (margin/page-width) touches neither. */
  applyStyle(style: ReadingStyle): void {
    const prev = this.style;
    this.style = style;
    if (!prev) {
      this.reinject();
      this.applyFonts();
      this.applyDynamic();
      return;
    }
    const geom = GEOMETRY_STYLE_KEYS.some((k) => prev[k] !== style[k]);
    const paint = PAINT_STYLE_KEYS.some((k) => prev[k] !== style[k]);
    const track = TRACK_STYLE_KEYS.some((k) => prev[k] !== style[k]);
    const ref = REF_STYLE_KEYS.some((k) => prev[k] !== style[k]); // RAWY-281
    // RAWY-208: the @font-face sheet is rewritten ONLY when a font slot really changed. A geometry
    // change (alignment/weight/leading/zoom) must leave it byte-identical, so the engine keeps the
    // loaded faces and the text never falls back mid-change. A font change DOES re-declare — that
    // re-fetch is correct, and it reflows anyway (both fonts are in GEOMETRY_STYLE_KEYS too).
    const fonts = FONT_STYLE_KEYS.some((k) => prev[k] !== style[k]);
    if (fonts) this.applyFonts();
    if (geom) this.reinject(); // inherent reflow — buildReadingCss also re-emits the fresh ink
    if (geom || paint) this.applyDynamic(); // colour/tashkīl in place (no @font-face, no expand)
    // RAWY-200: a tracking-only change redraws the overlay at the current sentence with the new colour/
    // opacity/on-off — no CSS re-inject, no reflow. `readingRedrawCb` (wired by Reader) calls back into
    // showReadingHighlight (+ the pill), so an OFF flips the effect away immediately, an ON restores it,
    // and a colour change repaints in place. Guarded so it fires only while a TTS session is on-screen.
    if (track && !geom && this.ttsUnitsIndex >= 0) this.readingRedrawCb?.();
    // RAWY-281: a twin-rule change repaints the reference marks in place — no re-inject, no reflow, the
    // same no-cost route the tracking overlays take. NOT gated on `!geom`, and that is deliberate: the
    // overlayer's own `redraw()` (which a reflow triggers) re-runs the STORED draw options, so after a
    // geometry change the marks would otherwise come back with the PREVIOUS colour/size. Re-adding them
    // is what replaces those options. Cheap either way — it is a handful of <rect>s on the rendered
    // sections, and it no-ops entirely for a book with no references.
    if (ref) this.drawReferences();
  }

  /** Update theme colours + book flags (override-colour, hide-titles). */
  applyTheme(theme: Theme, flags: BookThemeFlags): void {
    this.theme = theme;
    this.flags = flags;
    this.reinject();
    this.applyDynamic(); // RAWY-140: theme ink → refresh the in-book PAINT sheet to match
    // Highlights store a semantic slot → re-draw them in the new theme's colours.
    for (const [cfi, color] of this.annotations) this.view?.addAnnotation({ value: cfi, color });
    // RAWY-281: the twin rule's DEFAULT colour is this theme's accent (#9C5A3C ivory · #97582F sepia ·
    // #C98A5E slate + true-black — the four the design file names, and the other twelve besides), so a
    // theme change moves it exactly as it moves a highlight. A book with an explicit `refRuleColor`
    // redraws to the same colour it already had; nothing is lost either way.
    this.drawReferences();
  }

  // ---- highlights / notes anchoring (RAWY-20) ----
  private resolveColor(color: string): string {
    if (/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(color)) return color; // custom hex
    const set = this.theme?.colors.highlight as Record<string, string> | undefined;
    return set?.[color] ?? HL_FALLBACK[color] ?? color;
  }
  private rectInParent(rect: RectLike, doc: Document): AnchorRect {
    const fr = (doc.defaultView as Window & { frameElement?: Element })?.frameElement?.getBoundingClientRect();
    const ox = fr?.left ?? 0;
    const oy = fr?.top ?? 0;
    return { left: ox + rect.left, top: oy + rect.top, width: rect.width, height: rect.height, bottom: oy + rect.bottom };
  }
  // RAWY-262: `rangeRectInParent(index, range)` lived here to anchor the editor from the show-annotation
  // event, which carried a section INDEX rather than a doc. The dblclick path already has the clicked
  // DOCUMENT in hand, so it calls rectInParent directly and the index-lookup wrapper had no callers left.

  onSelection(cb: (sel: SelectionInfo | null) => void): void {
    this.selectionCb = cb;
  }
  /** RAWY-230 (§4): return keyboard focus to the reading frame — so SPACE/arrows reach the reading shortcuts
   *  (onSpace/onArrow) instead of a chrome button that kept focus. Focuses the content iframe element (where a
   *  page click puts focus), falling back to the foliate-view host. */
  focusReadingView(): void {
    try {
      const win = this.view?.renderer?.getContents?.()?.[0]?.doc?.defaultView;
      const frame = (win?.frameElement as HTMLElement | null | undefined) ?? null;
      if (frame?.focus) frame.focus();
      else (this.view as unknown as HTMLElement | undefined)?.focus?.();
    } catch {
      /* torn-down / cross-doc frame — ignore (the window key handler still works from <body>) */
    }
  }

  /** RAWY-122: drop any live text selection (content frame + parent). Dismissing the selection popover
   *  used to only HIDE it — the browser selection lingered, so a later pointerup re-fired the toolbar
   *  and the text stayed visibly selected. Callers clear it on Esc / click-away so a select-to-read is
   *  effortless to cancel. */
  clearSelection(): void {
    try {
      this.contentDoc?.getSelection?.()?.removeAllRanges?.();
    } catch {
      /* cross-doc access can throw on a torn-down frame — ignore */
    }
    try {
      window.getSelection?.()?.removeAllRanges?.();
    } catch {
      /* ignore */
    }
  }
  onShowAnnotation(cb: (hit: AnnotationHit) => void): void {
    this.showCb = cb;
  }
  /** RAWY-72: receive pointer activity from inside the content frame (parent-viewport coords + a
   *  tap flag) so the reader can wake the auto-hiding chrome on movement/tap over the reading text. */
  onActivity(cb: (x: number, y: number, isTap: boolean) => void): void {
    this.activityCb = cb;
  }
  /** RAWY-73: receive scroll-direction intent (scrolled mode) so the reader can hide on scroll-down /
   *  show on scroll-up. `down` = the reader scrolled toward later content. */
  /** A Ctrl+Wheel over the book text. The Reader converts it into a `ReadingStyle.zoom` change —
   *  this only reports that it happened, so there is exactly one zoom system (D6). */
  onZoomIntent(cb: (deltaY: number) => void): void {
    this.zoomIntentCb = cb;
  }
  private zoomIntentCb: ((deltaY: number) => void) | null = null;

  onScrollIntent(cb: (down: boolean) => void): void {
    this.scrollIntentCb = cb;
  }
  /** RAWY-180 (Part B): handle Space pressed with focus INSIDE the reading frame. `cb` returns true if
   *  it consumed the key (a TTS session was active → toggled play/pause), in which case we preventDefault
   *  so Space doesn't also scroll/page; false leaves Space's normal reading behaviour intact. */
  onSpace(cb: () => boolean): void {
    this.spaceCb = cb;
  }
  /** RAWY-184 (Part C): handle Left/Right arrow with focus INSIDE the reading frame. `cb(key)` returns
   *  true if it consumed the key (a TTS session was active → skipped a sentence), so we preventDefault;
   *  false leaves the arrow's normal page-turn intact. */
  /**
   * RESILIENCE-1 / WP-4C — THE ONE OWNER OF A PAGE-TURN KEY.
   *
   * MEASURED before this existed: ArrowRight did nothing on a fresh open, after a toolbar click, or
   * after clicking the desk margin, because the ONLY page-turn handlers lived on the book iframe's
   * document, and a reader's focus is not always inside it. A keydown in a child frame does not
   * bubble to the parent window, so in those states the key reached no handler at all.
   *
   * Both entry points — the frame's own listener and the parent window's (Reader.tsx) — now call
   * THIS, so the behaviour cannot differ by where focus happens to be. Exactly one of them sees any
   * given physical keypress (a frame event never crosses to the parent, and the parent only receives
   * keys when focus is outside the frame), so there is no double turn.
   *
   * Returns true when the key was consumed, so the caller knows whether to preventDefault.
   */
  handleNavKey(key: string): boolean {
    // The intent table lives in `navIntent.ts` — ONE copy, shared with its tests, and taking no
    // direction argument so a script direction cannot re-enter the decision.
    const intent = navIntent(key);
    if (!intent) return false;

    // RAWY-184: while read-aloud runs, the arrows skip the previous/next SENTENCE instead of turning
    // a page — the callback reports whether it claimed the key. EPUB only; a PDF has no sentences.
    if (!this.isFixedLayout && (key === "ArrowLeft" || key === "ArrowRight")) {
      if (this.arrowCb?.(key)) return true;
    }
    if (intent === "forward") this.forward();
    else this.backward();
    return true;
  }

  onArrow(cb: (key: string) => boolean): void {
    this.arrowCb = cb;
  }
  /** RAWY-74/75: scroll the book by a wheel delta coming from OUTSIDE the content iframe — i.e. the
   *  reading-area side MARGINS, where the native wheel can't reach foliate's scroller (it lives in
   *  the iframe's closed shadow root). Scrolled mode only. A wheel over the TEXT never reaches here
   *  (it fires inside the iframe, past the frame boundary), so there is no double-scroll.
   *  RAWY-75 made this path behave EXACTLY like the native text path, fixing the intermittency:
   *  (1) it scrolls via the paginator's `scrollByDelta` Sard patch — a plain container-scroll move,
   *  like a native wheel — instead of `scrollBy`, whose bounds are frozen at the last NAVIGATION's
   *  offset and dead-stopped forwarded wheels one screen past any chapter open/jump (measured:
   *  start 2027 → clamped at exactly 2677 = 2027 + one 650px screen, with 20k px of chapter left);
   *  (2) it runs the same RAWY-25 chapter-boundary gesture as the text path, so a margin wheel at a
   *  chapter edge advances/holds exactly like wheeling over the text (previously it dead-stopped). */
  scrollByWheel(deltaY: number): void {
    if (!this.scrolledMode || !deltaY) return;
    this.onWheelScrollIntent(deltaY);
    const r = this.view?.renderer;
    if (!r) return;
    const action = this.wheelBoundaryAction(deltaY);
    if (action === "next") r.next?.();
    else if (action === "prev") r.prev?.();
    else if (action === "scroll") {
      if (typeof r.scrollByDelta === "function") r.scrollByDelta(deltaY);
      else r.scrollBy?.(deltaY, 0); // stale-engine fallback (pre-patch vendored copy)
    }
    // "hold": at the edge mid-gesture — do nothing, same as the text path's preventDefault
  }
  // Debounce wheel deltas into a directional intent: accumulate within ONE gesture (a pause resets
  // — RAWY-75), reset on a direction flip (so a reversal is responsive), and fire once a clear
  // stretch of travel builds up in one direction. A DOM wheel deltaY > 0 means scrolling DOWN
  // (content moves up) → hide. Thresholds are asymmetric (RAWY-75): hide is near-immediate, show
  // needs a deliberate multi-notch scroll-up so a light upward nudge doesn't pop the bar.
  private onWheelScrollIntent(deltaY: number): void {
    // RAWY-128: the single funnel for a MANUAL wheel (both the content-frame and margin paths) — stamp
    // it so the TTS scroll-follow can yield briefly and not fight the user's scroll (see followReadingSentence).
    if (deltaY) this.lastUserScrollTs = performance.now();
    if (!this.scrollIntentCb || !deltaY) return;
    const now = performance.now();
    if (now - this.scrollIntentTs > SCROLL_GESTURE_GAP_MS) this.scrollAccum = 0;
    this.scrollIntentTs = now;
    if (Math.sign(deltaY) !== Math.sign(this.scrollAccum)) this.scrollAccum = 0;
    this.scrollAccum += deltaY;
    if (this.scrollAccum >= SCROLL_HIDE_PX) {
      this.scrollAccum = 0;
      this.scrollIntentCb(true);
    } else if (this.scrollAccum <= -SCROLL_SHOW_PX) {
      this.scrollAccum = 0;
      this.scrollIntentCb(false);
    }
  }
  /** Add/redraw a highlight for a range CFI; returns the section's chapter label. */
  async addHighlight(cfi: string, color: string, alpha?: number | null): Promise<string | null> {
    this.annotations.set(cfi, color);
    if (alpha == null) this.hlAlpha.delete(cfi);
    else this.hlAlpha.set(cfi, alpha);
    const res = await this.view?.addAnnotation({ value: cfi, color });
    return res?.label ?? null;
  }
  removeHighlight(cfi: string): void {
    this.annotations.delete(cfi);
    this.hlAlpha.delete(cfi);
    this.view?.deleteAnnotation({ value: cfi });
  }
  /** RAWY-259: set this highlight’s ink density and redraw it alone; null = theme default. */
  setHighlightAlpha(cfi: string, alpha: number | null): void {
    if (alpha == null) this.hlAlpha.delete(cfi);
    else this.hlAlpha.set(cfi, alpha);
    const color = this.annotations.get(cfi);
    if (color) this.view?.addAnnotation({ value: cfi, color }); // re-add → redraw this one mark only
  }
  setHighlightColor(cfi: string, color: string): void {
    this.annotations.set(cfi, color);
    this.view?.addAnnotation({ value: cfi, color }); // re-add → redraw new colour
  }
  async loadHighlights(list: { cfi: string; color: string; alpha?: number | null }[]): Promise<void> {
    for (const h of list) {
      this.annotations.set(h.cfi, h.color);
      // RAWY-259: seed the density map BEFORE the draw, so the first paint already carries the reader's
      // saved value instead of flashing the theme default and correcting itself later.
      if (h.alpha == null) this.hlAlpha.delete(h.cfi);
      else this.hlAlpha.set(h.cfi, h.alpha);
      await this.view?.addAnnotation({ value: h.cfi, color: h.color });
    }
  }

  /** RAWY-258: the paper the ink is mixed INTO on a dark theme — the per-book custom page colour (RAWY-201)
   *  when the reader has set one, else the theme's own paper. Keeps the Ink Swatch correct on every theme
   *  AND on a book the reader has recoloured, instead of assuming a fixed page. */
  private get inkPaper(): string {
    return this.style?.pageColor || this.theme?.colors?.paperBg || "#000000";
  }

  /** Is the reader currently in scrolled mode? */
  get isScrolled(): boolean {
    return this.scrolledMode;
  }

  /** RAWY-249 (PART 2): the reading scroll position along the scroll axis (scrolled flow). ~0 at a section
   *  top. Lets the Reader detect a chapter entry that landed at the top — its opening under the top bar. */
  get readingScrollTop(): number {
    const s = (this.view?.renderer as { start?: number } | undefined)?.start;
    return typeof s === "number" ? s : 0;
  }

  /** RAWY-249 (PART 2): true when a scrolled-flow chapter landed at/near its TOP, so its opening sits within
   *  the top-bar band and would be occluded while the bar is SHOWN. The bar height is read from its REAL
   *  rendered element (`.reader-chrome .rc-top`) — the single source (global.css) — never a 2nd hardcoded 70.
   *  At a section top the scroll can't push the opening down (nothing above it) without changing the layout
   *  inset (forbidden — RAWY-142), so the Reader instead hides the bar; this decides WHEN. */
  openingUnderTopBar(): boolean {
    if (!this.scrolledMode) return false;
    const bar = document.querySelector(".reader-chrome .rc-top");
    const barH = bar instanceof HTMLElement ? bar.getBoundingClientRect().height : 70;
    return this.readingScrollTop < barH;
  }

  /** RAWY-256: map every TOC href to its spine SECTION index, in ONE pass. Built from `book.sections[i].id`
   *  — the SAME primitive `sectionTocLabel` uses (RAWY-229's section-identity family), so there is no new
   *  notion of "which chapter". Deliberately NOT `resolveNavigation` per entry: the owner's largest book has
   *  1432 TOC rows, and this costs one walk of the sections plus one of the TOC instead of 1432 resolutions.
   *  A TOC href may carry a fragment (`file.html#anchor`), so both the raw href and its pre-`#` part are
   *  keyed. The Reader calls this ONCE per book (when the TOC loads) and reuses the result for every render. */
  // ---------------------------------------------------------------------------
  // RESILIENCE-1 (NAV-2) — which TOC entry is the reader actually inside?
  //
  // THE DEFECT. foliate's `TOCProgress.getProgress` (progress.js:38-55) walks the entries that point
  // into the current section and returns the one before the first anchor that lies BELOW THE BOTTOM
  // of the viewport; if no anchor is below it, it falls through to `items[items.length - 1]`.
  //
  // So whenever several TOC anchors are visible AT ONCE, it reports the LAST of them — whatever the
  // reader is actually looking at. Alice's front matter is exactly that shape: a title, an edition
  // line and a "Contents" heading, three headings inside ~530 px of one document. MEASURED on the
  // real app: sitting exactly on anchor 0, foliate reported "Contents"; on anchor 1, "Contents"; and
  // while reading through the section, "Contents" throughout. The first two entries could NEVER be
  // reported as current — so the Contents panel never highlighted them, and clicking them was
  // indistinguishable from clicking "Contents".
  //
  // THE RULE HERE, which is what a reader expects: the active entry is the LAST anchor at or before
  // the TOP of the viewport; before any anchor is reached, the section's first entry.
  //
  // WHY NOT PATCH THE ENGINE. `getProgress` also serves `#pageProgress` (the printed page-list), and
  // the pin already carries four local patches. Doing it here keeps the engine untouched and makes
  // the blast radius exact: `refineTocEntry` returns null unless a section holds MORE THAN ONE entry,
  // so 14 of the 15 corpus books take foliate's answer byte-for-byte, as before.
  //
  // COORDINATE-FREE ON PURPOSE. It compares DOM positions through `Range.comparePoint`, not pixels,
  // so it is identical in scrolled and paged flow and in both reading directions — the three
  // coordinate systems where a pixel comparison would have needed three different right answers.
  // ---------------------------------------------------------------------------

  /** TOC entries grouped by the section they point into, in TOC order. Built once per book. */
  private tocBySection: Map<number, TocSectionEntry[]> | null = null;

  private buildTocBySection(): Map<number, TocSectionEntry[]> {
    const out = new Map<number, TocSectionEntry[]>();
    const sections = this.view?.book?.sections as { id?: string }[] | undefined;
    if (!sections) return out;
    const sectionOf = new Map<string, number>();
    sections.forEach((s, i) => {
      if (s?.id) sectionOf.set(s.id, i);
    });
    for (const entry of flattenToc(this.view?.book?.toc)) {
      if (!entry.href) continue;
      const [path, fragment] = entry.href.split("#");
      // Only entries WITH a fragment can be distinguished from one another inside a section; an
      // entry without one is the section itself and needs no refinement.
      if (!fragment) continue;
      const index = sectionOf.get(path) ?? sectionOf.get(entry.href);
      if (typeof index !== "number") continue;
      const list = out.get(index) ?? [];
      list.push({ href: entry.href, label: entry.label, fragment });
      out.set(index, list);
    }
    return out;
  }

  /**
   * RESILIENCE-1 (NAV-3) — a section that NO TOC entry points at.
   *
   * A cover or a full-page illustration is usually absent from the table of contents: Alice's spine
   * begins with `wrap0000.xhtml`, and its TOC's first entry points at the NEXT document. MEASURED on
   * that page: foliate's `TOCProgress` returns `null` (its `map` has no group for the section and
   * inherits nothing, progress.js:29-33), so no entry was current, the Contents panel highlighted
   * nothing, and the page read as if it sat outside the book entirely.
   *
   * It does not. The reader is BEFORE the first entry that follows it, so that entry is the one they
   * are heading toward — the same reasoning `pickActiveTocEntry` uses within a section, applied
   * between sections. Front matter now belongs to the book's opening entry instead of to nothing.
   */
  private firstTocEntryAfterSection(index: number): { href: string; label: string } | null {
    const bySection = this.tocHrefSectionMap();
    for (const entry of flattenToc(this.view?.book?.toc)) {
      if (!entry.href) continue;
      const sec = bySection.get(entry.href) ?? bySection.get(entry.href.split("#")[0]);
      if (typeof sec === "number" && sec > index) return { href: entry.href, label: entry.label };
    }
    return null;
  }

  /**
   * The TOC entry the reader is inside, or `null` to keep foliate's own answer.
   *
   * `null` whenever the section holds fewer than two fragment-bearing entries — which is every
   * section of almost every book — so this changes nothing except where foliate provably cannot
   * give a correct answer.
   */
  private refineTocEntry(index: unknown, range: unknown): { href: string; label: string } | null {
    if (typeof index !== "number") return null;
    try {
      this.tocBySection ??= this.buildTocBySection();
      const entries = this.tocBySection.get(index);
      if (!entries || entries.length < 2) return null; // nothing to disambiguate

      const doc = this.contentDoc;
      if (!doc) return null;
      const r = range as Range | undefined;
      if (!r || typeof r.comparePoint !== "function") return entries[0]; // no position yet → the section's own entry

      // The WHOLE visible range, deliberately — see `pickActiveTocEntry`. It is what tells us which
      // anchors are ON SCREEN, and in paged flow a column begins mid-content, so a heading on the
      // current page routinely sits after the range's start point.
      const locate = (fragment: string): AnchorPosition => {
        const el = doc.getElementById(fragment) ?? doc.querySelector(`[name="${CSS.escape(fragment)}"]`);
        // "missing" rather than a guess: a TOC pointing at an id the section does not contain is
        // common in converted books, and treating it as reached would jump the highlight forward.
        if (!el) return "missing";
        try {
          // Intersection first — it is the direct answer to "is this heading on screen?" and has no
          // boundary case when the range begins inside the heading itself.
          if (r.intersectsNode(el)) return "visible";
          return r.comparePoint(el, 0) < 0 ? "passed" : "ahead";
        } catch {
          return "missing"; // detached node / different document — unknown, never "reached"
        }
      };

      // WHEN POSITION CANNOT DECIDE, INTENT DOES.
      //
      // Two TOC entries can share one page: Alice's edition line and its "Contents" heading are
      // 182 px apart and always land in the same column, so in paged flow they are simultaneously
      // and equally on screen. No position-based rule can separate them — a page cannot scroll
      // within itself — and preferring either one by position alone makes the other unclickable.
      //
      // The active entry has two determinants: where the reader IS (reading) and what they asked
      // for (navigating). This applies the second, and ONLY while the requested anchor is still
      // visible — so it resolves exactly the ambiguous case and evaporates the moment the reader
      // moves on. It can never pin the highlight: `locate` decides whether it survives.
      const requested = this.requestedTocHref
        ? entries.find((e) => e.href === this.requestedTocHref)
        : undefined;
      if (requested && locate(requested.fragment) === "visible") return requested;
      this.requestedTocHref = null; // no longer on screen (or a different section) — position rules

      return pickActiveTocEntry(entries, locate);
    } catch {
      return null; // a torn-down frame or a detached range must never break relocate
    }
  }

  /**
   * href → spine index for the contents being DISPLAYED.
   *
   * WP-6B: the caller may pass the list it actually adopted. Defaulting to the engine's own `book.toc`
   * was silently wrong the moment Sard displayed a different source — measured: with the NCX contents
   * on screen, a map built from the 1-entry navigation document matched nothing, so no row was ever
   * marked current, the highlight never appeared and the panel never scrolled to the current chapter.
   * The map must describe the list the reader is looking at.
   */
  tocHrefSectionMap(entries: TocEntry[] = this.getToc()): Map<string, number> {
    const out = new Map<string, number>();
    const sections = this.view?.book?.sections as { id?: string }[] | undefined;
    if (!sections) return out;
    const byId = new Map<string, number>();
    sections.forEach((s, i) => {
      if (s?.id) byId.set(s.id, i);
    });
    for (const t of entries) {
      const href = t.href;
      if (!href) continue;
      const i = byId.get(href) ?? byId.get(href.split("#")[0]);
      if (typeof i === "number") out.set(href, i);
    }
    return out;
  }

  /** RAWY-250 (addendum 6): the spine SECTION a jump target (CFI or TOC href) resolves to, WITHOUT
   *  navigating — foliate's own `resolveNavigation`, the same resolver `goTo` uses internally, so the answer
   *  is by construction the section the jump will land in. This makes jump-driven section changes detectable
   *  by IDENTITY instead of by timing: the Reader pre-arms its chapter tracker with this index, so the
   *  landing relocate is not a section CHANGE at all and can never be mistaken for reading on — however late
   *  it arrives, and however many relocates the engine emits for one jump (an `onExpand` re-anchor emits
   *  another). Returns null if the target cannot be resolved, so the caller can fall back. */
  targetSectionIndex(target: string): number | null {
    const v = this.view as unknown as { resolveNavigation?: (t: string) => { index?: number } | undefined } | null;
    try {
      const i = v?.resolveNavigation?.(target)?.index;
      return typeof i === "number" && i >= 0 ? i : null;
    } catch {
      return null; // an out-of-bounds / malformed target — the caller keeps its timing fallback
    }
  }

  /** RAWY-250 (PART 0.4 case 2): did the view land at/near the START of the current chapter? The read-marker
   *  requires the chapter to have been ENTERED at its beginning (a natural advance, a TOC click, or a resume
   *  that lands at the top) — a mid-chapter jump must NOT mark it read, because the reader never saw the
   *  first half (a FALSE "read" is worse than a missing one: it makes the owner skip what he never read).
   *  Purely GEOMETRIC, so it needs NO new persistent state, no arming, and never touches a CFI. */
  atChapterStart(): boolean {
    const r = this.view?.renderer as { page?: number; size?: number } | undefined;
    if (!r || this.isFixedLayout) return false;
    if (this.scrolledMode) return this.readingScrollTop <= CHAPTER_START_SLACK_PX;
    return (r.page ?? 0) <= 1; // first text page of the section
  }

  /** RAWY-249 (PART 1): scroll so `range` sits at the VERTICAL CENTRE of the reading viewport, instead of
   *  foliate's default top-align (goToSearchHit → renderer.scrollToAnchor → #scrollToRect, which lands the
   *  rect at the container top — the owner's "result appears at the top, not the middle"). SCROLLED flow only:
   *  it is a vertical nudge, so RTL/LTR-agnostic (RAWY-232). Reuses the measured `scrollByDelta` path the TTS
   *  follow uses (RAWY-75/128) — a plain container scroll the browser clamps to the real limits, so near a
   *  section edge (little content above/below) it lands the hit as close to centre as the content allows.
   *  Paged flow is page-indexed with NO in-page centring (DECISIONS D63) — left at foliate's landing. */
  private centerRangeInView(index: number, range: Range): void {
    if (!this.scrolledMode) return;
    const r = this.view?.renderer;
    const contents = r?.getContents?.() as { index: number; doc?: Document }[] | undefined;
    const content = contents?.find((x) => x.index === index) ?? contents?.[0];
    const doc = content?.doc;
    if (!r || !doc) return;
    const raw = range.getBoundingClientRect();
    if (!(raw.width > 0) && !(raw.height > 0)) return; // not laid out yet
    const pr = this.rectInParent(raw, doc); // hit rect in PARENT-viewport coords
    const rv = (r as Element).getBoundingClientRect?.(); // the visible reading box
    if (!rv || !(rv.height > 0)) return;
    // >0 scrolls down (content up); <0 scrolls up (content down) — same convention as followReadingSentence.
    const delta = pr.top - (rv.top + rv.height / 2 - pr.height / 2);
    const rd = r as { scrollByDelta?: (d: number) => void };
    if (typeof rd.scrollByDelta === "function") rd.scrollByDelta(delta);
  }

  // Chapter-boundary scroll gesture (RAWY-25). Scrolling is continuous WITHIN a chapter
  // (native). At the chapter edge we preventDefault so a single gesture STOPS at the boundary
  // (never chains into the next chapter); a NEW gesture (after BOUNDARY_PAUSE_MS) that BEGINS
  // at the edge advances to the next/prev section (foliate loads it anchored at the top/bottom).
  // RAWY-75: the boundary-gesture decision, shared by BOTH wheel paths — the content iframe's
  // native wheel (onBoundaryWheel) and the forwarded margin wheel (scrollByWheel). One physical
  // wheel = one gesture state, and the two paths are mutually exclusive per event (the frame
  // boundary), so sharing wheelTs/gestureEdge/gestureActed is exactly right. Returns what the
  // caller should do: advance a section, hold at the edge, or scroll normally.
  private wheelBoundaryAction(deltaY: number): "next" | "prev" | "hold" | "scroll" {
    const r = this.view?.renderer;
    if (!r) return "scroll";
    const viewSize = r.viewSize as number;
    const size = r.size as number;
    const start = r.start as number;
    // Renderer not laid out yet (getters 0/NaN) → never trap the wheel, or we'd freeze the page.
    if (!(viewSize > 0) || !(size > 0)) return "scroll";
    const now = performance.now();
    const fresh = now - this.wheelTs > BOUNDARY_PAUSE_MS;
    this.wheelTs = now;
    const scrollable = viewSize - size > BOUNDARY_EDGE_PX;
    const atBottom = scrollable ? viewSize - (start + size) <= BOUNDARY_EDGE_PX : true;
    const atTop = start <= BOUNDARY_EDGE_PX;
    if (fresh) {
      this.gestureEdge = atBottom ? "bottom" : atTop ? "top" : null;
      this.gestureActed = false;
    }
    const down = deltaY > 0;
    if (down && atBottom) {
      if (this.gestureEdge === "bottom" && !this.gestureActed) {
        this.gestureActed = true;
        return "next";
      }
      return "hold";
    } else if (!down && atTop) {
      if (this.gestureEdge === "top" && !this.gestureActed) {
        this.gestureActed = true;
        return "prev";
      }
      return "hold";
    }
    return "scroll";
  }

  private onBoundaryWheel(e: WheelEvent): void {
    // Ctrl+Wheel is a ZOOM intent, not a scroll, and it is answered FIRST — before the flow-mode
    // guard below, which returns early in paged mode. (That guard is why this listener is now
    // registered in both flows: see the registration site.)
    //
    // The engine reports the intent and does nothing else: `ReadingStyle.zoom` belongs to the Reader
    // (D6), and a second zoom owned down here is exactly the "two systems competing" that
    // `webview_chrome.rs` disabled the browser's own zoom to prevent. `preventDefault` is safe
    // because this listener is registered non-passive.
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      this.zoomIntentCb?.(e.deltaY);
      return;
    }
    const r = this.view?.renderer;
    if (!r || !this.scrolledMode) return;
    // RAWY-73: scroll intent for the chrome auto-hide runs FIRST, unconditionally — even before the
    // layout guard — so scrolling always drives hide/show (the content iframe's wheel is the only
    // place the parent can observe scroll direction; foliate scrolls inside a closed shadow root).
    this.onWheelScrollIntent(e.deltaY);
    const action = this.wheelBoundaryAction(e.deltaY);
    if (action === "scroll") return; // mid-chapter — the browser's native scroll handles it
    e.preventDefault(); // at the edge: hold the boundary — never chain into a chapter mid-gesture
    if (action === "next") r.next?.();
    else if (action === "prev") r.prev?.();
  }

  /** Flattened TOC (chapters panel, RAWY-21). Empty if the book exposes none. */
  getToc(): TocEntry[] {
    return flattenToc(this.view?.book?.toc);
  }

  /**
   * RESILIENCE-1 / WP-6B — the book's NCX contents, flattened the same way as `getToc()`.
   *
   * WHY THIS EXISTS. An EPUB 3 book may ship a navigation document that is present, well-formed and
   * useless, and the engine consults the NCX only when the navigation document yields NOTHING
   * (`epub.js`: `if (!this.toc && ncxPath)`). Measured on three real books: a single "Start" link
   * beside an NCX carrying every chapter — 2963, 529 and 362 entries, each resolving 100% of the
   * linear spine. PROVEN CAUSALLY: removing `properties="nav"` from one of them (18 bytes) made the
   * engine produce all 529 real chapter titles, navigable, with no synthesis.
   *
   * This reads the SAME parse through the same engine, so labels and href resolution are identical to
   * a book that reaches the NCX naturally — 13 books in the measured library already do, and they
   * work. Nothing here decides anything: the choice belongs to the caller.
   */
  async getNcxToc(): Promise<TocEntry[]> {
    const book = this.view?.book as { getNCXToc?: () => Promise<unknown> } | undefined;
    if (typeof book?.getNCXToc !== "function") return [];
    try {
      return flattenToc(await book.getNCXToc());
    } catch {
      return []; // a malformed NCX is not a reason to fail the open
    }
  }

  /**
   * RESILIENCE-1 / WP-6A — build contents for a book whose own table of contents is useless.
   *
   * Walks the LINEAR spine once, reading each section through foliate's own `createDocument()` — the
   * same call in-book search uses, so this needs no rendering and no navigation. The decision about
   * WHICH label to use lives in `tocSynth.ts` (pure, and tested against both flagged books); this
   * method only gathers the material and turns the result into navigable entries.
   *
   * Called ONLY for a book WP-2 flagged `toc_degenerate`, and cached for the life of the view: it is
   * ~196 document parses on the measured book, which is affordable once and not per panel-open.
   * Yields to the event loop between chunks for the same reason `getChapterUnits` does — a long
   * synchronous walk freezes the window, which is the RAWY-182 lesson.
   */
  async getSynthesisedToc(): Promise<SynthToc | null> {
    if (this.synthToc) return this.synthToc;
    const book = this.view?.book;
    const sections: any[] = book?.sections ?? [];
    if (!sections.length) return null;

    const material: SectionHeading[] = [];
    const spineIndex: number[] = []; // material[i] came from spine section spineIndex[i]
    for (let i = 0; i < sections.length; i++) {
      const sec = sections[i];
      if (sec?.linear === "no") continue; // never offer a non-linear section as a chapter
      let doc: Document | null = null;
      try {
        doc = await sec.createDocument();
      } catch {
        continue; // an unreadable section simply contributes no row
      }
      // ONLY the heading is read. The section's text is deliberately never touched: a label derived
      // from a book's opening sentence would look like a title the author wrote, and none exists.
      const h = doc?.body?.querySelector("h1,h2,h3,h4,h5,h6");
      material.push({ heading: (h?.textContent ?? "").replace(/\s+/g, " ").trim() });
      spineIndex.push(i);
      if (material.length % UNITS_CHUNK === 0) await breathe();
    }

    this.synthToc = synthesiseToc(material, spineIndex);
    return this.synthToc;
  }

  /**
   * Navigate to a spine section by index — how a synthesised contents row moves the reader.
   *
   * The target is a NUMBER, not `{ index, anchor }`. foliate's `view.goTo()` RESOLVES a target: a
   * number becomes `{index}`, a `{fraction}` is looked up, a CFI is parsed, and anything else is
   * treated as an href and passed to `book.resolveHref()`. An already-resolved `{index, anchor}`
   * object matches none of those, so it fell through to `resolveHref({...})`, which cannot resolve it
   * — and because foliate catches that failure internally and only logs it, `goTo` returned
   * `undefined` and the reader simply did not move. No error surfaced, which is exactly why every
   * generated chapter row looked dead when clicked.
   *
   * MEASURED in the running app on a book with 116 generated rows:
   *   view.goTo({ index: 30, anchor: 0 })      -> returned undefined, index 0 -> 0   (did NOT move)
   *   view.goTo(30)                            -> returned {index:30}, index 0 -> 30 (moved)
   *   view.renderer.goTo({ index: 30, anchor: 0 }) -> index 0 -> 30                  (moved)
   *
   * `view.goTo` is used rather than the renderer's, so a generated row goes through the SAME path as
   * a native TOC row: history is pushed and `relocate` fires normally.
   */
  goToSection(index: number): Promise<unknown> | undefined {
    return this.view?.goTo?.(index);
  }

  /** Cached synthesised contents for THIS view; cleared with the view in `dispose()`. */
  private synthToc: SynthToc | null = null;

  /** RAWY-105 (TTS): the current chapter's text as an ordered list of sentences — the visible
   *  reading text, walked as LEAF blocks and segmented with Intl.Segmenter (Arabic-aware). Thin
   *  wrapper over `getChapterUnits` (RAWY-126) so the spoken sentences and the highlight ranges come
   *  from ONE walk and stay index-aligned. */
  async getCurrentChapterSentences(lang?: string): Promise<string[]> {
    return (await this.getChapterUnits(lang)).map((u) => u.text);
  }

  /** RAWY-162 (TTS resume): the section index of the currently-loaded chapter (foliate spine index),
   *  or -1. Used to decide whether a saved TTS cursor is in the chapter already on screen. */
  currentSectionIndex(): number {
    return this.view?.renderer?.getContents?.()?.[0]?.index ?? -1;
  }

  /** RAWY-229 (corrected): does a bookmark belong to the chapter currently ON SCREEN? A bookmark is a
   *  per-CHAPTER mark — its marker shows anywhere in that chapter (top to bottom, any scroll position) and
   *  hides ONLY when the reader leaves it. So this compares SECTION IDENTITY: the spine section of the
   *  bookmark's CFI vs the reader position's CFI. Both are foliate CFIs, so their spine steps are identical
   *  for the same chapter (foliate emits the same spine step for a section). NOT the visible range (that
   *  made the marker vanish mid-chapter and let the button add a 2nd bookmark) and NOT the whole-book
   *  fraction window (that lit the marker in every chapter of a long book — the original FEEDBACK 1.6 bug). */
  bookmarkVisible(bookmarkCfi: string | null | undefined, currentCfi: string | null | undefined): boolean {
    const a = this.cfiSection(bookmarkCfi);
    const b = this.cfiSection(currentCfi);
    return a != null && a === b;
  }

  /** RAWY-229: the SPINE SECTION of a foliate CFI — the step before `!` (or the whole inner CFI at a
   *  section boundary, which has no `!`), with any `[assertion]` stripped. Two CFIs in the same chapter
   *  share it exactly, so string equality is "same chapter". Pure; no engine call. */
  private cfiSection(cfi: string | null | undefined): string | null {
    if (!cfi) return null;
    const m = /^epubcfi\((.*)\)$/.exec(cfi.trim());
    const inner = m ? m[1] : cfi.trim();
    const spine = inner.split("!")[0].replace(/\[[^\]]*\]/g, "").trim();
    return spine || null;
  }

  /** RAWY-186: is the chapter the TTS SESSION is reading the one currently ON SCREEN? `ttsUnitsIndex`
   *  is the section the playing sentences were built from; it only changes when a new chapter is
   *  spoken (never when the reader merely navigates away — RAWY-129 decouples audio from the view). So
   *  once the user navigates to a DIFFERENT section while a session plays, this returns false, and the
   *  Play gesture can read the CURRENT chapter instead of resuming the old one (the 184-A regression).
   *  True when there is no session section yet (-1) so ordinary pause/resume is unaffected. */
  isTtsChapterOnScreen(): boolean {
    return this.ttsUnitsIndex < 0 || this.currentSectionIndex() === this.ttsUnitsIndex;
  }

  /** RAWY-162: a DURABLE cursor for the sentence currently being spoken (`i` into the retained units).
   *  `cfi` (from the sentence's live start range) survives app restarts and encodes the section, so a
   *  resume can navigate to it even from a different chapter; `sec`/`idx` are the fast same-section
   *  path; `snip` re-locates the sentence if re-segmentation shifted the index. Null if the units are
   *  stale (a chapter change) or `i` is out of range. Independent of the reading CFI/visual position. */
  getTtsCursor(i: number): { cfi: string; sec: number; idx: number; snip: string } | null {
    const content = this.view?.renderer?.getContents?.()?.[0];
    if (!content || content.index !== this.ttsUnitsIndex) return null;
    const unit = this.ttsUnits[i];
    if (!unit) return null;
    let cfi = "";
    if (unit.range) {
      try {
        cfi = (this.view as unknown as { getCFI(index: number, range: Range): string }).getCFI(this.ttsUnitsIndex, unit.range) || "";
      } catch {
        cfi = ""; // an un-CFI-able range degrades to a same-section-only cursor (sec/idx/snip)
      }
    }
    return { cfi, sec: this.ttsUnitsIndex, idx: i, snip: unit.text.slice(0, 60) };
  }

  /** RAWY-227 (listen-from-selection): map a captured selection RANGE to the current chapter's TTS unit
   *  index — the unit whose range starts at/before the selection start (DOM order, exact). Replaces the
   *  brittle first-24-char text match, which returned -1 (→ chapter TOP) whenever the selection didn't
   *  begin a segmented sentence or Arabic `Intl.Segmenter` split it differently. The units must already be
   *  built for the section on screen (getCurrentChapterSentences did so); returns -1 if the range isn't in
   *  that section (caller then falls back to a text match, then to index 0). */
  ttsUnitIndexForRange(range: Range | null | undefined): number {
    if (!range) return -1;
    const content = this.view?.renderer?.getContents?.()?.[0];
    if (!content || content.index !== this.ttsUnitsIndex) return -1;
    let best = -1;
    for (let i = 0; i < this.ttsUnits.length; i++) {
      const r = this.ttsUnits[i].range;
      if (!r) continue;
      let cmp: number;
      try {
        // START_TO_START: is unit `r` at/before the selection start? (both ranges are in the same content
        // doc, so this is a valid DOM comparison). Units are in document order, so break once we pass it.
        cmp = r.compareBoundaryPoints(Range.START_TO_START, range);
      } catch {
        return -1; // wrong-document / detached → let the caller fall back
      }
      if (cmp <= 0) best = i;
      else break;
    }
    return best;
  }

  /** RAWY-126: the current chapter walked into `{text, range}` UNITS — the reading-indicator's
   *  lockstep source. The queue speaks `units[i].text`; the spotlight highlights `units[i].range`.
   *  The list is built + RETAINED here (with the section index it belongs to) so `showReadingHighlight`
   *  can draw range N when the queue reaches sentence N. The CRITICAL invariant: this is the SAME
   *  order + SAME hidden-skip the queue sees — a misaligned index would light up the wrong (or a
   *  hidden) node. Units are pre-trimmed/non-empty, so the TTS store's own `.filter(Boolean)` is a
   *  no-op and can't shift the indices.
   *
   *  RAWY-107 preserved: leaf blocks are STRUCTURE-agnostic (any block-ish container holding text but
   *  no nested block-ish container), the hidden chapter-title / first-line are skipped, and if NO
   *  visible leaf holds text the whole body is read as a fallback (so a visibly-full chapter is never
   *  reported empty) — but that fallback yields `range: null` (no highlight; honest degrade). */
  async getChapterUnits(lang?: string): Promise<{ text: string; range: Range | null }[]> {
    const content = this.view?.renderer?.getContents?.()?.[0];
    const doc: Document | undefined = content?.doc;
    if (!doc?.body) {
      this.ttsUnits = [];
      this.ttsUnitsIndex = -1;
      return [];
    }
    // RAWY-292: a PDF page carries pdf.js's own TEXT LAYER — real positioned spans over the rendered
    // image. That is a DOM, so read-aloud reuses this same unit contract ({text, range}) and the same
    // highlighting; only the extraction differs, because the text needs repairing before it is spoken
    // (see lib/pdfText.ts — most Arabic PDFs here emit presentation forms, not letters).
    if (this.isFixedLayout) {
      const units = this.pdfPageUnits(doc);
      this.ttsUnits = units;
      this.ttsUnitsIndex = content?.index ?? this.pdfPageIndex;
      this.ttsLang = lang;
      return units;
    }
    const win = doc.defaultView;
    const CONTAINER = "p, h1, h2, h3, h4, h5, h6, li, blockquote, div, section, article";
    const norm = (s: string) => s.replace(/\s+/g, " ").trim();

    // Don't speak the HIDDEN chapter title / first line (hide-title + hide-first-line hide via
    // `visibility:hidden`, RAWY-22/69) — a cheap per-leaf skip; the whole-body fallback below still
    // guarantees a text-bearing chapter is never reported empty.
    const isHidden = (el: Element): boolean => {
      const cs = win?.getComputedStyle(el);
      return !!cs && (cs.visibility === "hidden" || cs.display === "none");
    };

    // Intl.Segmenter is present in WebView2/Chromium but not always in the TS lib — type it locally.
    type SegPart = { index: number; segment: string };
    type Segmenter = { segment: (s: string) => Iterable<SegPart> };
    const Seg = (Intl as unknown as {
      Segmenter?: new (l: string, o: { granularity: string }) => Segmenter;
    }).Segmenter;
    const seg: Segmenter | null = Seg ? new Seg(lang || "en", { granularity: "sentence" }) : null;

    // RAWY-182 (first-play non-block): the walk (per-container `querySelector` + `getComputedStyle` +
    // `Intl.Segmenter` + Range build) used to run in ONE synchronous pass that froze the thread on a big
    // chapter — the RAWY-181 "preparing" pill showed but the shrink button couldn't respond until audio
    // started. Now iterate the containers in CHUNKS and yield to the event loop between them, so queued
    // input is handled and the thread breathes. The order (document order), the leaf filter, the per-leaf
    // `segmentBlock`, and the whole-body fallback are UNCHANGED, so the produced units are IDENTICAL
    // (spotlight 126 / karaoke 127 / resume 162 alignment is unaffected).
    const all = doc.body.querySelectorAll(CONTAINER);
    const units: { text: string; range: Range | null }[] = [];
    let anyLeaf = false;
    for (let i = 0; i < all.length; i++) {
      const el = all[i];
      if (
        !el.querySelector(CONTAINER) && // leaf containers only (no double-count)
        !isHidden(el) &&
        !el.closest(".sard-title-ph") && // skip hidden title / first-line
        (el.textContent ?? "").trim()
      ) {
        anyLeaf = true;
        this.segmentBlock(el, doc, seg, norm, units);
      }
      if ((i + 1) % UNITS_CHUNK === 0 && i + 1 < all.length) await breathe();
    }
    if (!anyLeaf) {
      // No visible leaf held text: the chapter has NO block-level container at all. Measured on the
      // reported book "داو الخالد العجيب" (a .txt→EPUB conversion): every chapter is `<span>`s
      // separated by `<br>` directly inside `<body>`, so `CONTAINER` — which lists only block
      // elements — matched 0 nodes in all 88 chapter documents.
      //
      // This used to read `body.textContent` and emit units with `range: null` — "honest
      // no-highlight". But that is the one failure the reader cannot understand: `text` still feeds
      // the TTS queue, so speech plays perfectly, while `showReadingHighlight` skips a null range and
      // `setReadingWords` returns early, so the spotlight and the word pill NEVER appear. Audible,
      // invisible, with nothing on screen to explain it (112 units, 0 ranges, before this change).
      //
      // Nothing about the DOM prevented mapping: the text nodes are ordinary and addressable.
      // `segmentBlock` already walks every text node under an element, segments the joined string
      // once, and maps each sentence's char offsets back to a live Range — so pointing it at <body>
      // gives these chapters exactly the same units, ranges and RAWY-247 length-splitting as any
      // other book, through the same proven code. This branch is unreachable for a chapter that has
      // even one block container, so no well-formed book takes it.
      this.segmentBlock(doc.body, doc, seg, norm, units);
      // Last resort, preserving the original guarantee that a text-bearing chapter is never reported
      // empty — e.g. a body whose only text sits in nodes `segmentBlock` declines to map.
      if (units.length === 0) {
        const whole = norm(doc.body.textContent ?? "");
        if (hasSpeech(whole)) units.push({ text: whole, range: null });
      }
    }

    this.ttsUnits = units;
    this.ttsUnitsIndex = content?.index ?? -1;
    this.ttsLang = lang; // RAWY-129: remember it so a return-to-chapter rebuild segments identically
    // DIAGNOSTIC BUILD: publish the section these units belong to. `followReadingSentence` and the
    // overlay handler both refuse to draw unless this equals the DISPLAYED section, and that
    // comparison is invisible from outside the controller — it is the single fact needed to tell
    // "no highlight because the sections disagree" from "no highlight for some other reason".
    publishDiagUnits(this.ttsUnitsIndex, units.length, this.view?.renderer?.getContents?.()?.[0]?.index ?? null);
    return units;
  }

  /** RAWY-126: segment one leaf block into `{text, range}` units. Adapts foliate's own tts.js
   *  running-sum offset math: gather the block's non-empty text nodes, segment the RAW joined string
   *  ONCE, and for each sentence map its [start,end] char offsets back to a live DOM Range — so the
   *  spoken text and its highlight range are produced together and can never drift apart. */
  private segmentBlock(
    el: Element,
    doc: Document,
    seg: { segment: (s: string) => Iterable<{ index: number; segment: string }> } | null,
    norm: (s: string) => string,
    out: { text: string; range: Range | null }[],
  ): void {
    const walker = doc.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    const strs: string[] = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const t = n as Text;
      if (t.data.length) {
        nodes.push(t);
        strs.push(t.data);
      }
    }
    if (nodes.length === 0) return;
    const full = strs.join("");
    if (!full.trim()) return;
    const makeRange = (si: number, so: number, ei: number, eo: number): Range | null => {
      try {
        const r = doc.createRange();
        r.setStart(nodes[si], so);
        r.setEnd(nodes[ei], eo);
        return r;
      } catch {
        return null; // defensive — a bad offset never breaks extraction
      }
    };
    if (!seg) {
      const t = norm(full);
      if (hasSpeech(t)) out.push({ text: t, range: makeRange(0, 0, nodes.length - 1, strs[nodes.length - 1].length) });
      return;
    }
    // RAWY-247: random-access char-offset → (node, offset) mapping. `prefix[i]` is the cumulative length of
    // nodes before node i, so `locate(off)` finds the node holding `off` in O(nodes). This REPLACES the old
    // monotonic running-sum (needed because splitting an over-long unit maps offsets that no longer advance
    // in order) and is PROVEN byte-identical to it (129/129 segments in the RAWY-247 offline check).
    const prefix: number[] = [0];
    for (const s of strs) prefix.push(prefix[prefix.length - 1] + s.length);
    const locate = (off: number): [number, number] => {
      let i = 0;
      while (i + 1 < prefix.length && prefix[i + 1] <= off) i++;
      return [i, off - prefix[i]];
    };
    // Build a DOM Range for the char span [a,b) of the concatenated text — same inclusive-end math the old
    // code used (`end = b-1`, `endOffset = eoInc + 1`).
    const rangeFor = (a: number, b: number): Range | null => {
      const [si, so] = locate(a);
      const [ei, eoInc] = locate(b - 1);
      return makeRange(si, so, ei, eoInc + 1);
    };
    for (const { index, segment } of seg.segment(full)) {
      const t = norm(segment);
      if (!hasSpeech(t)) continue;
      // RAWY-247: normal (under-cap) units are UNCHANGED — one unit per ICU sentence, its range unchanged.
      if (t.length <= MAX_TTS_UNIT_CHARS) {
        out.push({ text: t, range: rangeFor(index, index + segment.length) });
        continue;
      }
      // Over-long unit (an Arabic clause-chain joined only by «،»/«…», etc.) → subdivide at safe pause
      // boundaries so Edge can synthesize each piece; each sub-span gets its own tiling range so the
      // spotlight/karaoke stay aligned (RAWY-230), and punctuation-only pieces still drop (index-aligned).
      for (const [a, b] of splitLongSpan(full, index, index + segment.length)) {
        const st = norm(full.slice(a, b));
        if (hasSpeech(st)) out.push({ text: st, range: rangeFor(a, b) });
      }
    }
  }

  /** A dev/debug surface reachable from DevTools without shipping any UI — the same convention as
   *  `window.__sardTtsStats` (lib/tts.ts). Reports what the TRACKING pipeline actually produced for
   *  the loaded chapter, so "speech plays but nothing highlights" can be MEASURED rather than
   *  reasoned about: `ranged` is the count of units carrying a live DOM Range, and a unit without one
   *  is spoken and never highlighted. `unranged > 0` is the signature of that whole failure class.
   *
   *  Rebuilds the units when no TTS session owns them — which is exactly what pressing Play does —
   *  and otherwise reports the retained set, so inspecting it can never disturb playback. */
  async trackStats(lang?: string): Promise<{
    section: number;
    units: number;
    ranged: number;
    unranged: number;
    rebuilt: boolean;
  }> {
    const live = this.ttsUnitsIndex >= 0;
    const units = live ? this.ttsUnits : await this.getChapterUnits(lang ?? this.ttsLang);
    const ranged = units.filter((u) => u.range).length;
    return {
      section: this.ttsUnitsIndex,
      units: units.length,
      ranged,
      unranged: units.length - ranged,
      rebuilt: !live,
    };
  }

  /** RAWY-129 (A): register the Reader's redraw — invoked after the TTS chapter's overlay is (re)created
   *  (a return to the still-playing chapter) so the spotlight/pill re-attach at the current sentence. */
  onReadingRedraw(cb: () => void): void {
    this.readingRedrawCb = cb;
  }

  // ---- RAWY-126: the sentence "spotlight" reading highlight (transient; never persisted) ----

  /** Draw the reading spotlight on sentence `i` of the retained units. Talks DIRECTLY to the current
   *  section's overlayer with a RESERVED key — never `addAnnotation`/the annotations map/the DB, so it
   *  can't collide with a user highlight (RAWY-123) or be saved. Guards: skips if the loaded section
   *  isn't the one the units were built for (a chapter change → clear), or the sentence has no range
   *  (whole-body fallback → honest no-highlight). */
  showReadingHighlight(i: number): void {
    // RAWY-295: PDF takes the span-marking branch. Same caller, same index, same `ttsUnits` — the
    // only thing that differs is the surface, because a fixed-layout page has no overlayer.
    if (this.isFixedLayout) {
      // TEMPORARY (2026-08-08): defence in depth. `pdfHasSpeakableText()` already prevents a PDF
      // session from ever starting, so nothing should reach here — but a caller that obtained an index
      // another way must not paint into a page whose feature is switched off.
      if (!PDF_TTS_ENABLED) return;
      this.pdfHighlightIndex = i;
      this.pdfMarkUnit(i);
      return;
    }
    const content = this.view?.renderer?.getContents?.()?.[0];
    const overlayer = content?.overlayer as
      | { add: (k: string, r: Range, d: typeof drawReadingSpotlight, o: unknown) => void; remove: (k: string) => void }
      | undefined;
    if (!content || !overlayer) return;
    if (content.index !== this.ttsUnitsIndex) {
      this.clearReadingHighlight();
      return;
    }
    try {
      overlayer.remove(READING_KEY);
      overlayer.remove(WORD_KEY); // RAWY-127: drop the old sentence's pill; the new one re-draws it
    } catch {
      /* not present — fine */
    }
    // RAWY-200: spotlight OFF genuinely removes it — we already removed the old key above and simply
    // skip the add, so NO SVG is drawn (no invisible-but-computed overlay, no DOM cost, no layout
    // shift). Tracking LOGIC is untouched: ttsUnits/index still advance; only the draw is suppressed.
    if (this.style && this.style.ttsSpotlightOn === false) return;
    const range = this.ttsUnits[i]?.range;
    if (!range) return; // out of range / whole-body fallback → no highlight (honest)
    try {
      overlayer.add(READING_KEY, range, drawReadingSpotlight, { dark: this.theme?.dark ?? false, style: this.style });
    } catch {
      /* stale/detached range (chapter navigated mid-play) — skip silently */
    }
  }

  /** Remove the reading spotlight AND the word pill (stop / play closed / left the chapter). */
  clearReadingHighlight(): void {
    // RAWY-295: forget the index FIRST, so a text-layer rebuild racing this call cannot repaint the
    // mark we are removing. Clearing is unconditional — a book can switch from PDF to EPUB while the
    // controller is reused (`Reader` renders one instance with no `key`), so both surfaces are cleared.
    this.pdfHighlightIndex = null;
    this.pdfClearMarks();
    const overlayer = this.view?.renderer?.getContents?.()?.[0]?.overlayer as
      | { remove: (k: string) => void }
      | undefined;
    try {
      overlayer?.remove(READING_KEY);
      overlayer?.remove(WORD_KEY); // RAWY-127
    } catch {
      /* ignore */
    }
    this.wordRanges = [];
  }

  // ---- RAWY-127: the word "pill" karaoke (Edge only; transient, never persisted) ----

  /** Build the per-word sub-ranges for sentence `i` from the ordered Edge WORD list. Each word is
   *  located in the sentence's own text by an advancing cursor (match the word TEXT — robust to the
   *  whitespace/punctuation between words, and to RTL since matching is in logical order), then mapped
   *  to a live DOM sub-range of the sentence range. A word that can't be matched verbatim (a number
   *  Edge spoke differently, say) falls back to consuming its char length — so the cursor never stalls.
   *  No-op when the sentence has no timing (Piper) → the pill simply never shows (Phase-1 only). */
  setReadingWords(sentenceIndex: number, words: { text: string }[] | undefined): void {
    this.wordRanges = [];
    if (this.isFixedLayout || !words?.length) return;
    const content = this.view?.renderer?.getContents?.()?.[0];
    if (!content || content.index !== this.ttsUnitsIndex) return;
    const range = this.ttsUnits[sentenceIndex]?.range;
    const doc: Document | undefined = content.doc;
    if (!range || !doc) return;
    const map = this.rangeNodeMap(range, doc);
    if (!map) return;
    const { full, sub } = map; // `full` = the sentence's raw text; `sub(a,b)` → a Range for [a,b)
    let cursor = 0;
    const ranges: (Range | null)[] = [];
    for (const w of words) {
      const text = w.text ?? "";
      if (!text) { ranges.push(null); continue; }
      let pos = full.indexOf(text, cursor);
      let len = text.length;
      if (pos < 0) {
        // not found verbatim — skip whitespace, then consume the word's own length from the cursor
        let c = cursor;
        while (c < full.length && /\s/.test(full[c])) c++;
        pos = c;
        len = Math.min(text.length, Math.max(0, full.length - pos));
      }
      ranges.push(len > 0 ? sub(pos, pos + len) : null);
      cursor = pos + len;
    }
    this.wordRanges = ranges;
  }

  /** Draw the solid pill on word `w` of the current sentence (or clear it when `w < 0` / unmapped).
   *  Painted OVER the sentence band (added after it), under the reserved WORD_KEY — transient. */
  showReadingWord(w: number): void {
    if (this.isFixedLayout) return;
    const content = this.view?.renderer?.getContents?.()?.[0];
    const overlayer = content?.overlayer as
      | { add: (k: string, r: Range, d: typeof drawReadingPill, o: unknown) => void; remove: (k: string) => void }
      | undefined;
    if (!overlayer) return;
    try {
      overlayer.remove(WORD_KEY);
    } catch {
      /* not present — fine */
    }
    if (!content || content.index !== this.ttsUnitsIndex) return;
    // RAWY-200: karaoke OFF removes the pill (we removed WORD_KEY above) and skips the add — the sentence
    // band still shows if spotlight is on. Independent of the spotlight, as required. Logic untouched:
    // wordIndex still advances; only the draw is suppressed.
    if (this.style && this.style.ttsKaraokeOn === false) return;
    const range = w >= 0 ? this.wordRanges[w] : null;
    if (!range) return; // no word / unmapped → no pill (the sentence band still shows)
    try {
      overlayer.add(WORD_KEY, range, drawReadingPill, { dark: this.theme?.dark ?? false, style: this.style });
    } catch {
      /* stale/detached range — skip */
    }
  }

  /** RAWY-127: map a sentence Range to its raw text `full` + a `sub(start,end)` that returns a live
   *  sub-Range for a `[start,end)` char span — reused per Edge word to place the pill. Walks the
   *  range's text nodes (clamping the boundary nodes) so tashkīl-split nodes (RAWY-65) still resolve. */
  private rangeNodeMap(
    range: Range,
    doc: Document,
  ): { full: string; sub: (a: number, b: number) => Range | null } | null {
    const nodes: Text[] = [];
    const starts: number[] = []; // offset within each node where its in-range text begins
    const strs: string[] = []; // the in-range text of each node
    const cac = range.commonAncestorContainer;
    const pushNode = (n: Text) => {
      let s = 0;
      let e = n.data.length;
      if (n === range.startContainer) s = range.startOffset;
      if (n === range.endContainer) e = range.endOffset;
      const text = n.data.slice(s, e);
      if (text) { nodes.push(n); starts.push(s); strs.push(text); }
    };
    if (cac.nodeType === Node.TEXT_NODE) {
      pushNode(cac as Text);
    } else {
      const walker = doc.createTreeWalker(cac, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (range.intersectsNode(n)) pushNode(n as Text);
      }
    }
    if (nodes.length === 0) return null;
    const full = strs.join("");
    const sub = (a: number, b: number): Range | null => {
      if (b <= a || a < 0 || b > full.length) return null;
      let acc = 0;
      let si = -1;
      let so = 0;
      let ei = -1;
      let eo = 0;
      for (let j = 0; j < strs.length; j++) {
        const len = strs[j].length;
        if (si < 0 && a < acc + len) { si = j; so = starts[j] + (a - acc); }
        if (ei < 0 && b <= acc + len) { ei = j; eo = starts[j] + (b - acc); break; }
        acc += len;
      }
      if (si < 0 || ei < 0) return null;
      try {
        const r = doc.createRange();
        r.setStart(nodes[si], so);
        r.setEnd(nodes[ei], eo);
        return r;
      } catch {
        return null;
      }
    };
    return { full, sub };
  }

  /** Gentle scroll-follow: keep the spoken sentence in view. PROGRAMMATIC (never a synthetic wheel),
   *  so it can't trip the RAWY-25 chapter-boundary gesture or the RAWY-73 scroll-intent chrome
   *  auto-hide (both are wheel-driven) — the chrome stays put during auto-scroll for free. Scrolled
   *  mode: only nudge when the sentence leaves a 15–85% comfort band, landing it ~30% down.
   *  Paged mode: flip to its page only when the sentence's centre is off the visible box. */
  followReadingSentence(i: number): void {
    if (this.isFixedLayout) return;
    // RAWY-128: never fight a manual scroll. If the user wheeled within the last window, skip the
    // auto-follow this advance — the spotlight/pill still track the audio (only the VIEW isn't pulled),
    // and the gentle follow resumes on the next sentence once the user settles. Fixes the scroll
    // hitch/heaviness the owner hit while scrolling during read-aloud.
    if (performance.now() - this.lastUserScrollTs < FOLLOW_SUPPRESS_MS) return;
    const content = this.view?.renderer?.getContents?.()?.[0];
    if (!content || content.index !== this.ttsUnitsIndex) {
      // DIAGNOSTIC BUILD: this is the early return the audit flagged. Name the exact condition.
      diagFollow(i, !content ? "no rendered content" : "displayedSection != ttsUnitsSection", {
        displayedSectionIndex: content?.index ?? null,
        ttsUnitsSectionIndex: this.ttsUnitsIndex,
      });
      return;
    }
    const range = this.ttsUnits[i]?.range;
    const doc: Document | undefined = content.doc;
    const r = this.view?.renderer;
    if (!range || !doc || !r) {
      diagFollow(i, !range ? "no range for this sentence index" : !doc ? "no section document" : "no renderer", {
        unitCount: this.ttsUnits.length,
      });
      return;
    }
    const raw = range.getBoundingClientRect();
    if (!(raw.width > 0) && !(raw.height > 0)) {
      // Zero client rects is the "stale ranges after returning to a chapter" case.
      diagFollow(i, "range has zero client rects (not laid out / stale)", { width: raw.width, height: raw.height });
      return;
    }
    const pr = this.rectInParent(raw, doc); // range rect in PARENT-viewport coords
    const rv = (r as Element).getBoundingClientRect?.(); // the visible reading box
    if (!rv || !(rv.height > 0)) return;
    if (this.scrolledMode) {
      // RESILIENCE-1: the comfort band must end where the OCCLUSION starts, not where the box does.
      // The read-aloud transport is `position: fixed` over the reading area (~30% of a 720px window),
      // so the old 85% bottom sat INSIDE it: a sentence at 80% counted as "comfortably in view" while
      // being physically behind the pill. Measured at sentence 6 of 30 — the spoken sentence was
      // underneath the transport and the reader could not see the words being read to them.
      const comfortTop = rv.top + rv.height * 0.15;
      const obstructed = this.readingObstructionTop();
      const comfortBottom = Math.min(rv.top + rv.height * 0.85, (obstructed ?? rv.bottom) - 8);
      // If the transport leaves no usable band (a very short window), fall through to the nudge
      // rather than thrashing the scroll on every sentence.
      if (comfortBottom > comfortTop && pr.top >= comfortTop && pr.bottom <= comfortBottom) return;
      const delta = pr.top - (rv.top + rv.height * 0.3); // >0 scrolls down (content up)
      if (typeof r.scrollByDelta === "function") r.scrollByDelta(delta);
    } else {
      const cx = pr.left + pr.width / 2;
      const cy = pr.top + pr.height / 2;
      const inView = cx >= rv.left && cx <= rv.right && cy >= rv.top && cy <= rv.bottom;
      if (!inView) r.scrollToAnchor?.(range); // flip to the sentence's page
    }
  }

  /**
   * Top edge of whatever is FLOATING over the reading area right now, in viewport coords — or `null`
   * when nothing is. Today that is the read-aloud transport (`.tts-pill`), which is `position: fixed`
   * and therefore invisible to any layout-based measure of "in view".
   *
   * Deliberately reads the live element rather than hard-coding the pill's height: the transport
   * grows and shrinks (collapsed vs expanded, the chapter-end and Edge-error states), and a constant
   * would be wrong in most of them. Hidden states are honoured — immersive mode fades the pill to
   * `opacity: 0`, and a faded pill occludes nothing.
   */
  private readingObstructionTop(): number | null {
    if (typeof document === "undefined") return null;
    const pill = document.querySelector(".tts-pill");
    if (!pill) return null;
    const cs = getComputedStyle(pill);
    if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) < 0.05) return null;
    const r = pill.getBoundingClientRect();
    return r.height > 0 ? r.top : null;
  }

  /** Jump to a TOC target (an href; foliate resolves it). */
  goToHref(href: string): Promise<unknown> | undefined {
    // RESILIENCE-1 (NAV-2): remember WHICH entry was asked for. Position alone cannot always say
    // which TOC entry is current — see `refineTocEntry` — and when it cannot, what the reader asked
    // for is the answer. Held only while that entry is still on screen.
    this.requestedTocHref = href;
    return this.view?.goTo(href);
  }

  /** The TOC entry the reader last navigated to, while it remains visible. See `refineTocEntry`. */
  private requestedTocHref: string | null = null;

  /**
   * NAVIGATION IS IN READING ORDER, NOT SCREEN GEOMETRY.
   *
   * `forward()` is always the NEXT page of the book and `backward()` always the previous one, for an
   * Arabic book exactly as for an English one.
   *
   * These replace `next()`/`prev()`, which called foliate's `goLeft()`/`goRight()` — and those are
   * direction-aware (`goLeft() { return dir === 'rtl' ? next() : prev() }`), so they move the page
   * PHYSICALLY. The result, measured on real books: in an LTR book ArrowRight went FORWARD, and in an
   * RTL book the same key went BACKWARD. Reported from real reading as "the arrows are reversed".
   *
   * Screen direction must not invert what a control MEANS, and Sard already agreed with itself on
   * that everywhere else: the PDF path has always mapped ArrowRight to `view.next()`, and the
   * read-aloud skip maps ArrowRight to +1 with the explicit note "media convention, NOT mirrored in
   * RTL" (lib/tts.ts). EPUB paging was the lone outlier, so this makes it match the rest of the app
   * rather than introducing a new convention.
   */
  forward(): void {
    this.view?.next?.();
  }
  backward(): void {
    this.view?.prev?.();
  }

  /** RAWY-227: the chapter the end-of-chapter "next chapter" control advances FROM. It MUST be the chapter
   *  the TTS session just finished (`ttsUnitsIndex`, the section the spoken sentences were built from), NOT
   *  the DISPLAYED section: RAWY-129 decouples audio from the view, so the reader may have manually moved
   *  the display ahead of (or behind) the audio. Anchoring on `currentSectionIndex()` then overshot — view
   *  on ch2 while ch1 finished → `+1` = ch3 (the double-jump). Falls back to the displayed section only
   *  when no session owns the units (`ttsUnitsIndex < 0`); the chapter-end control never fires without one. */
  private ttsAnchorSection(): number {
    return this.ttsUnitsIndex >= 0 ? this.ttsUnitsIndex : this.currentSectionIndex();
  }
  /** RAWY-184 (Part B): is there a chapter AFTER the one that just finished? (for the end-of-chapter "next"
   *  control). RAWY-227: anchored on the TTS chapter, not the displayed section. */
  hasNextSection(): boolean {
    const cur = this.ttsAnchorSection();
    const n = this.view?.book?.sections?.length ?? 0;
    return cur >= 0 && cur + 1 < n;
  }
  /** RAWY-184 (Part B): advance to the NEXT chapter (spine section) and await it, so the caller can then
   *  read it from the top. RAWY-227: "next" is relative to the TTS chapter (`ttsAnchorSection`), so a
   *  manual display move while listening no longer makes it overshoot the finished chapter. */
  async goToNextChapter(): Promise<void> {
    const n = this.view?.book?.sections?.length ?? 0;
    const next = this.ttsAnchorSection() + 1;
    if (next <= 0 || next >= n) return;
    // foliate's `view.goTo(number)` resolves a bare spine INDEX (resolveNavigation: number → {index}) and
    // awaits the render — more reliable than a page-step when the reading position isn't exactly at the edge.
    try {
      await this.view?.goTo?.(next);
    } catch {
      this.view?.goLeft?.(); // fallback: a forward step (from the chapter end this reaches the next section)
    }
  }

  // RAWY-86: PDF (fixed-layout) paging by wheel — one page per gesture, throttled. Uses LOGICAL
  // forward/back (view.next/prev), so scroll-down advances in reading order regardless of dir.
  private lastPageWheel = 0;
  /**
   * RAWY-293: TWO NAVIGATION LAYERS for a fixed-layout page.
   *
   *   Layer 1 — move inside the CURRENT page while it still has unseen content.
   *   Layer 2 — turn the page, but only once layer 1 cannot consume the scroll in that direction.
   *
   * Before this, a zoomed PDF turned the page on the first wheel notch, so anything below the fold of
   * an enlarged page was unreachable: zoom to 400%, and four fifths of the page could not be read.
   * At fit-page there is nothing to scroll, so layer 1 never fires and paging behaves exactly as it
   * always did — the normal-zoom behaviour is preserved by construction, not by a separate branch.
   */
  pageByWheel(deltaY: number, deltaX = 0): void {
    if (!this.isFixedLayout || (!deltaY && !deltaX)) return;
    const r = this.view?.renderer as HTMLElement | undefined;
    if (r) {
      // Layer 1. `foliate-fxl`'s host is the scroll container (`:host { overflow: auto }`), so when the
      // rendered page is larger than the viewport it has real scrollable extent.
      const maxY = r.scrollHeight - r.clientHeight;
      const maxX = r.scrollWidth - r.clientWidth;
      if (deltaY && maxY > 1) {
        const before = r.scrollTop;
        const next = Math.max(0, Math.min(maxY, before + deltaY));
        if (Math.abs(next - before) > 0.5) { r.scrollTop = next; return; }
      }
      // A horizontal wheel (or a wide page at high zoom) moves across before it turns a page.
      if (deltaX && maxX > 1) {
        const before = r.scrollLeft;
        const next = Math.max(0, Math.min(maxX, before + deltaX));
        if (Math.abs(next - before) > 0.5) { r.scrollLeft = next; return; }
      }
      // Reaching here means the page is at its edge in the requested direction: fall through to a turn.
      if (!deltaY) return; // a purely horizontal gesture must never turn the page
    }
    const now = performance.now();
    if (now - this.lastPageWheel < 280) return; // ~one page per wheel notch/gesture
    this.lastPageWheel = now;
    const forward = deltaY > 0;
    if (forward) this.view?.next?.();
    else this.view?.prev?.();
    // Land where reading continues: the top of the next page, the BOTTOM of the previous one, so
    // paging backwards through a zoomed document does not skip the part just left behind.
    const host = r;
    if (host) {
      window.setTimeout(() => {
        const max = host.scrollHeight - host.clientHeight;
        if (max > 1) host.scrollTop = forward ? 0 : max;
      }, 120);
    }
  }

  /**
   * RAWY-292: read-aloud units for ONE PDF page, from pdf.js's text layer.
   *
   * MAPPING. The text is repaired before it is spoken, and repair changes lengths (a lam-alef ligature
   * becomes two letters), so char offsets into the raw DOM would drift. Units are therefore mapped at
   * SPAN granularity: each span is normalised first, the normalised runs are joined, and a sentence's
   * range spans the first and last span it touches. The reader hears repaired text while the highlight
   * sits on the glyphs actually drawn — which is what a reader wants to see.
   *
   * A page with no usable text yields no units. That is not an error: three of the six PDFs measured
   * here are scans, and the honest answer for them is silence plus an explanation in the UI.
   */
  private pdfPageUnits(doc: Document): { text: string; range: Range | null }[] {
    const layer = doc.querySelector(".textLayer");
    if (!layer) return [];
    // Record the RAW page text toward the document verdict HERE, not at page load: pdf.js renders the
    // text layer asynchronously, so at load time it is still empty. Sampling it then made every
    // document — including ones producing perfectly good units — report "no text layer".
    //
    // RAWY-295: the SAMPLING and the STICKY FLAG stay in this wrapper, deliberately. The derivation
    // below is now also called by the sentence highlighter on every unit change and every re-render —
    // if the sampling moved with it, one page would be pushed into `pdfSeenPages` dozens of times and
    // the document verdict's `coverage` would be computed from a corpus of duplicates.
    if (this.pdfSeenPages.length < 24) this.pdfSeenPages.push(layer.textContent ?? "");
    const { units, foundText } = this.pdfDeriveUnits(doc);
    if (foundText) this.pdfFoundText = true; // sticky: this DOCUMENT has speakable text somewhere
    return units.map((u) => ({ text: u.text, range: u.range }));
  }

  /**
   * RAWY-295: the one derivation, returning the covered SPANS alongside the unit.
   *
   * Read-aloud needs `{text, range}`; the sentence highlighter needs the spans. Deriving them twice
   * would be two algorithms that drift, and the highlight would eventually mark a different sentence
   * from the one being spoken. So there is exactly one walk, and `pdfPageUnits` is a projection of it.
   *
   * Pure apart from its return value — no sampling, no sticky flags — because the highlighter calls it
   * on every unit change and every text-layer rebuild.
   */
  private pdfDeriveUnits(doc: Document): { units: { text: string; range: Range | null; spans: Element[] }[]; foundText: boolean } {
    const layer = doc.querySelector(".textLayer");
    if (!layer) return { units: [], foundText: false };
    const spans = [...layer.querySelectorAll("span")].filter((s) => !s.classList.contains("endOfContent"));
    const parts: { el: Element; text: string; start: number; end: number }[] = [];
    let joined = "";
    for (const el of spans) {
      const clean = normalizePdfText(el.textContent ?? "");
      // Drop watermark-only runs here rather than page-wide: a URL span carries no prose to lose.
      if (!clean || !hasSpeakableText(clean)) continue;
      const start = joined.length ? joined.length + 1 : 0;
      joined = joined.length ? `${joined} ${clean}` : clean;
      parts.push({ el, text: clean, start, end: joined.length });
    }
    if (!parts.length || !hasSpeakableText(joined)) return { units: [], foundText: false };

    // Sentence segmentation, the same instrument the EPUB path uses.
    type SegPart = { index: number; segment: string };
    const Seg = (globalThis as unknown as { Intl?: { Segmenter?: new (l?: string, o?: object) => { segment: (s: string) => Iterable<SegPart> } } }).Intl?.Segmenter;
    const pieces: { text: string; start: number }[] = [];
    if (Seg) {
      try {
        const seg = new Seg(this.ttsLang || undefined, { granularity: "sentence" });
        for (const p of seg.segment(joined)) if (p.segment.trim()) pieces.push({ text: p.segment, start: p.index });
      } catch { /* fall through to the whole page */ }
    }
    if (!pieces.length) pieces.push({ text: joined, start: 0 });

    const units: { text: string; range: Range | null; spans: Element[] }[] = [];
    for (const p of pieces) {
      const text = stripPdfArtifacts(p.text);
      if (!hasSpeakableText(text)) continue;
      const from = p.start;
      const to = p.start + p.text.length;
      const hit = parts.filter((x) => x.end > from && x.start < to);
      let range: Range | null = null;
      if (hit.length) {
        try {
          range = doc.createRange();
          range.setStartBefore(hit[0].el);
          range.setEndAfter(hit[hit.length - 1].el);
        } catch { range = null; }
      }
      units.push({ text, range, spans: hit.map((h) => h.el) });
    }
    return { units, foundText: true };
  }

  // ---- RAWY-295: PDF sentence highlighting ----------------------------------------------------
  //
  // The fixed-layout path has NO overlayer (`overlayerInDoc: false`), and it needs none. pdf.js has
  // already positioned every text run as a <span> over the page image, so a sentence highlight is one
  // CSS class on the spans the active unit covers — no rects, no coordinate maths, no second surface.
  //
  // MEASURED, and each one shaped the design:
  //   * The page document survives a zoom, but the SPANS DO NOT — the vendored render clears the text
  //     layer on every re-render, so a mark must be re-derived rather than kept. Holding a span list or
  //     a live Range across a zoom would leave the highlight pointing at detached nodes.
  //   * Re-deriving BY INDEX is safe: unit count, unit text and the span mapping are identical at
  //     fit-page / 2x / 3x / 4x (`[18,2,2,2,1]` at every level), so index N is the same sentence.
  //   * The injected <style> DOES survive a re-render (it lives in <head>, not in `.textLayer`), so only
  //     the class is re-applied, never the stylesheet.
  //   * The highlight cannot be recoloured or covered by a theme: the theme's filter targets
  //     `#canvas img` and its tint is `#canvas::after`, and the text layer is outside `#canvas`.
  /** Reserved, prefixed, and never a user annotation — the same rule as READING_KEY / WORD_KEY. */
  private static readonly PDF_HL_CLASS = "sard-pdf-reading";
  private static readonly PDF_HL_STYLE_ID = "sard-pdf-reading-style";
  /** The unit currently highlighted, so a text-layer rebuild can restore it without asking the store. */
  private pdfHighlightIndex: number | null = null;
  /** Watches the text layer for the rebuild a zoom causes. One per page document; see `pdfWatchLayer`. */
  private pdfLayerObserver: MutationObserver | null = null;

  /** Ensure the highlight rule exists in this page document. Idempotent; sits beside the theme sheet. */
  private pdfEnsureHighlightStyle(doc: Document): void {
    const ID = FoliateController.PDF_HL_STYLE_ID;
    if (doc.getElementById(ID)) return;
    const el = doc.createElement("style");
    el.id = ID;
    // `background` only — deliberately NOT a filter, because the theme owns filters on this page and a
    // second one would compose with it differently under each of the eight themes. A translucent wash
    // reads correctly over both light paper and the two inverting themes.
    el.textContent = `.${FoliateController.PDF_HL_CLASS}{background:rgba(255,196,0,.34);border-radius:3px}`;
    (doc.head ?? doc.documentElement)?.appendChild(el);
  }

  /** Paint unit `i`, re-deriving the spans from the CURRENT DOM. Clears any previous mark first. */
  private pdfMarkUnit(i: number): void {
    const doc = this.pdfPageDoc;
    if (!doc) return;
    this.pdfClearMarks(doc);
    // Respect the same preference the EPUB spotlight does — one control, both formats.
    if (this.style && this.style.ttsSpotlightOn === false) return;
    const { units } = this.pdfDeriveUnits(doc);
    const spans = units[i]?.spans;
    if (!spans?.length) return; // no span for this unit → no highlight, exactly as a null range does
    this.pdfEnsureHighlightStyle(doc);
    for (const el of spans) el.classList.add(FoliateController.PDF_HL_CLASS);
  }

  /** Remove every mark from `doc` (defaults to the live page). Never touches the stylesheet. */
  private pdfClearMarks(doc?: Document | null): void {
    const d = doc ?? this.pdfPageDoc;
    if (!d) return;
    for (const el of [...d.querySelectorAll(`.${FoliateController.PDF_HL_CLASS}`)]) {
      el.classList.remove(FoliateController.PDF_HL_CLASS);
    }
  }

  /**
   * Re-apply the highlight after pdf.js rebuilds the text layer.
   *
   * A zoom re-render replaces every span, so the class is destroyed with them. Observing `childList` on
   * the layer catches that — and catches any OTHER cause of a rebuild too (a resize, a fit-mode
   * recompute), which hooking `setPdfZoom` alone would miss. `attributes` is deliberately NOT observed:
   * adding the class is an attribute mutation, and watching it would re-enter forever.
   */
  private pdfWatchLayer(doc: Document): void {
    this.pdfLayerObserver?.disconnect(); // a previous page's observer must never outlive its document
    this.pdfLayerObserver = null;
    // TEMPORARY (2026-08-08): with PDF read-aloud disabled there is never a highlight to restore, so
    // no observer is installed at all. The disconnect above still runs, so turning the feature off
    // mid-session releases any observer a previous page created rather than leaving it watching.
    if (!PDF_TTS_ENABLED) return;
    const layer = doc.querySelector(".textLayer");
    if (!layer) return;
    const obs = new MutationObserver(() => {
      if (this.pdfHighlightIndex == null) return;
      if (doc !== this.pdfPageDoc) return; // the page moved on; this observer is about to be replaced
      this.pdfMarkUnit(this.pdfHighlightIndex);
    });
    obs.observe(layer, { childList: true });
    this.pdfLayerObserver = obs;
  }

  /**
   * RAWY-292: how far this PDF's text layer can be trusted, sampled across the document rather than
   * from the open page — a title page proves nothing about the body. Cached per book: the sampling
   * renders pages, so it must not run on every play.
   */
  /** RAWY-293: does the page on screen actually yield speakable units? The read-aloud CONTROL is
   *  gated on this rather than on the sampled verdict, because it is the same code that would feed
   *  the speech engine — it cannot claim availability the pipeline would not honour. */
  /**
   * RAWY-294: apply the reading appearance INSIDE the PDF page's own document.
   *
   * It used to live on  — an ancestor that also contains the reading surround, so the
   * filter and tint were painted over the background too. No colour choice can fix that: an ancestor
   * filter applies to everything inside it by definition. Each PDF page is a same-origin iframe, so
   * styling the page document scopes the effect to the page by CONSTRUCTION: the surround is outside
   * the iframe and cannot be reached.
   */
  setPdfTheme(filter: string, tint: string): void {
    this.pdfTheme = { filter, tint };
    const doc = this.pdfPageDoc;
    if (!doc) return;
    const ID = 'sard-pdf-theme';
    let el = doc.getElementById(ID) as HTMLStyleElement | null;
    if (!el) {
      el = doc.createElement('style');
      el.id = ID;
      doc.head?.appendChild(el) ?? doc.documentElement.appendChild(el);
    }
    const hasTint = !!tint && tint !== "transparent";
    const f = filter && filter !== "none" ? filter : "none";
    // The tint is a MULTIPLY over the page image: it darkens white paper toward the paper colour and
    // leaves black ink black, which is what a paper tint physically is. A hue filter alone was
    // measured at 6-14/255 on a real scan — applied, but invisible.
    const overlay = hasTint
      ? `#canvas::after { content: ""; position: absolute; inset: 0; pointer-events: none;`
        + ` background: ${tint}; mix-blend-mode: multiply; }`
      : "";
    // `#canvas` is a block, so it can be WIDER than the page image — an overlay at `inset: 0` would
    // then tint beyond the real page edge. Shrink-wrapping it to the image (inline-block, no line-box
    // slack) makes the tint rectangle exactly the PDF page rectangle.
    el.textContent = `#canvas { position: relative; display: inline-block; font-size: 0; line-height: 0; }\n`
      + `#canvas img { filter: ${f}; display: block; }\n${overlay}\n`;
  }
  private pdfTheme: { filter: string; tint: string } | null = null;

  pdfHasSpeakableText(): boolean {
    // TEMPORARY (2026-08-08): PDF read-aloud is disabled at the product level — see `PDF_TTS_ENABLED`
    // in lib/pdfText.ts. This is the availability SOURCE, so returning false here removes the Listen
    // control and the player without touching either component: both render on `(!isPdf ||
    // pdfCanListen)`, and `pdfCanListen` polls exactly this method. The extraction below is left
    // intact and still reachable from the diagnostics, so the implementation stays exercised.
    if (!PDF_TTS_ENABLED) return false;
    if (!this.isFixedLayout) return false;
    const doc = this.pdfPageDoc;
    if (!doc) return false;
    try { return this.pdfPageUnits(doc).length > 0 || this.pdfFoundText; } catch { return this.pdfFoundText; }
  }

  pdfTextQuality(): PdfTextScore {
    return scorePdfDocument(this.pdfSeenPages.length ? this.pdfSeenPages : [""]);
  }
  private pdfSeenPages: string[] = [];
  private pdfFoundText = false;
  /** Cleared when a different book opens, so a verdict never leaks between documents. */
  resetPdfQuality(): void { this.pdfSeenPages = []; this.pdfFoundText = false; }

  /** RAWY-86: the number of pages in the open PDF (fixed-layout sections). */
  get pdfPageCount(): number {
    return this.view?.book?.sections?.length ?? 0;
  }

  /**
   * RAWY-291: set the PDF zoom. `fixed-layout.js` observes the `zoom` attribute and accepts a number,
   * "fit-width" or "fit-page"; for a PDF it calls back into pdf.js to RE-RENDER the page at that scale,
   * so zooming gains real resolution instead of magnifying the existing bitmap.
   *
   * Setting the attribute to its current value is a no-op in the DOM (no attributeChangedCallback), so
   * repeated identical writes during a wheel gesture cost nothing.
   */
  setPdfZoom(zoom: number | "fit-width" | "fit-page"): void {
    if (!this.isFixedLayout) return;
    const r = this.view?.renderer as HTMLElement | undefined;
    r?.setAttribute("zoom", String(zoom));
  }

  /**
   * The scale actually on screen. A fit mode resolves to a number only inside the renderer, so
   * stepping out of "fit-page" has to read what is rendered rather than assume 1 — otherwise the first
   * zoom-in after opening a book jumps instead of stepping.
   *
   * Measured from the rendered page image against the page's own intrinsic size, which is what the
   * renderer itself scales.
   */
  pdfRenderedScale(): number {
    try {
      const doc = this.pdfPageDoc;
      const img = doc?.querySelector("img") as HTMLImageElement | null;
      const host = this.view?.renderer as HTMLElement | undefined;
      if (!img || !host) return 1;
      // The <img> is sized in CSS pixels by pdf.js at `zoom * devicePixelRatio`, then the document is
      // scaled back down by 1/dpr — so the on-screen scale is the CSS width over the intrinsic width.
      const shown = img.getBoundingClientRect().width;
      const intrinsic = img.naturalWidth / (globalThis.devicePixelRatio || 1);
      if (!shown || !intrinsic) return 1;
      return Math.max(0.05, Math.min(12, shown / intrinsic));
    } catch {
      return 1;
    }
  }
  /** DEV (RAWY-87 #2): dispatch a synthetic wheel on the PDF page doc to exercise the page-wheel →
   *  pageByWheel forwarding added in the load handler. WebView2 can't inject a REAL wheel, but a real
   *  wheel over the page would fire on exactly this document, so this drives the same code path. */
  devPageWheel(deltaY: number): void {
    this.pdfPageDoc?.dispatchEvent(new WheelEvent("wheel", { deltaY, bubbles: true }));
  }
  /** RAWY-86: the current 0-based PDF page index (from the last relocate). */
  pdfPageIndex = 0;

  // RAWY-86: a basic in-PDF find — scan pages' text (from the page after `fromIndex`, wrapping once)
  // for `query`, jump to the first hit's page (by fraction), return its 0-based index (or null).
  // Capped so a no-match doesn't scan thousands of pages. Arabic text layers can be disconnected
  // upstream, so matches are best-effort.
  // RAWY-86: the current PDF page's document (captured on `load`) — used to read the text selection
  // for copy. The fixed-layout page renders into an iframe whose `load` fires the view's load event.
  private pdfPageDoc: Document | null = null;
  /** Copy the current text selection inside the PDF page to the clipboard; returns the copied text. */
  async copyPdfSelection(): Promise<string> {
    try {
      const sel = this.pdfPageDoc?.getSelection?.();
      const text = sel && !sel.isCollapsed ? sel.toString().trim() : "";
      if (text) await navigator.clipboard.writeText(text);
      return text;
    } catch {
      return "";
    }
  }
  goToLocator(cfi: string): Promise<unknown> | undefined {
    return this.view?.goTo(cfi);
  }
  /** Jump to a fraction (0..1) of the whole book — used by the dev seek hook + future slider. */
  goToFraction(frac: number): Promise<unknown> | undefined {
    return this.view?.goToFraction?.(Math.max(0, Math.min(1, frac)));
  }

  // RAWY-88: load the vendored engine's CFI comparator once (spoiler-safe ordering). Vite refuses to
  // let source import a /public module, so — like view.js (ensureFoliateDefined) — a runtime module
  // <script> (public/cfi-bridge.js) imports it and stashes `compare` on window; we poll for it.
  private async ensureCfiCompare(): Promise<void> {
    const w = window as unknown as { __sardCfiCompare?: (a: string, b: string) => number };
    if (this.cfiCompareFn) return;
    if (typeof w.__sardCfiCompare === "function") { this.cfiCompareFn = w.__sardCfiCompare; return; }
    if (!document.querySelector("script[data-cfibridge]")) {
      const s = document.createElement("script");
      s.type = "module";
      s.src = "/cfi-bridge.js";
      s.dataset.cfibridge = "1";
      document.head.appendChild(s);
    }
    for (let i = 0; i < 100 && typeof w.__sardCfiCompare !== "function"; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    this.cfiCompareFn = typeof w.__sardCfiCompare === "function" ? w.__sardCfiCompare : null;
  }
  /** The furthest-read CFI (spoiler-safe boundary) — null for a PDF / before any relocate. */
  get furthestPosition(): string | null {
    return this.furthestCfi;
  }

  /** RAWY-88: in-book search over the WHOLE book (EPUB only). Streams foliate's search generator into
   *  a flat, ordered list of hits — each with its chapter label, location fraction, split excerpt, and
   *  whether it lies AHEAD of the furthest-read position (for spoiler-safe). Diacritics-/case-
   *  insensitive: foliate matches with an Intl.Collator at `base` sensitivity (ignores tashkīl + case,
   *  folds hamza/alef variants). `draw:()=>{}` suppresses the engine's per-match outline (we do our own
   *  flash on jump); cancel via `signal`. RAWY-89: `onProgress` (scan fraction 0..1) + `onBatch` (a
   *  snapshot of hits so far) fire THROTTLED as sections are scanned, so the panel can show live,
   *  reassuring progress (an animated indicator + "N found · X% scanned" + results streaming in) on a
   *  long book — instead of a static "Searching…". */
  async searchBook(
    query: string,
    opts: { signal?: AbortSignal; onProgress?: (frac: number) => void; onBatch?: (hits: SearchHit[]) => void } = {},
  ): Promise<SearchHit[]> {
    const view = this.view;
    const q = query.trim();
    if (!view?.search || this.isFixedLayout || !q) return [];
    const n = view.book?.sections?.length ?? 0;
    const fractions: number[] = view.getSectionFractions?.() ?? [];
    const compare = this.cfiCompareFn;
    const boundary = this.furthestCfi;
    const hits: SearchHit[] = [];
    let curIndex = 0;
    let scanFrac = 0;
    // Throttle the UI callbacks — a 1000+ section book yields ~1000 progress ticks; firing setState on
    // each would thrash. Emit at most ~every 90ms (and always once at the end).
    let lastEmit = 0;
    const emit = (force: boolean) => {
      const now = performance.now();
      if (!force && now - lastEmit < 90) return;
      lastEmit = now;
      opts.onProgress?.(scanFrac);
      opts.onBatch?.(hits.slice());
    };
    // PERF (RAWY-178, follow-up to RAWY-175): foliate scans each section SYNCHRONOUSLY; once the render
    // is cheap (RAWY-175) these back-to-back scans monopolise the thread in one microtask sweep (the
    // longtasks PERF-01 saw). Yield a MACROtask periodically so the browser can paint / handle input
    // between sections. Every item is still consumed IN ORDER, so results / order / counts are unchanged.
    let lastYield = performance.now();
    try {
      // RAWY-289 — the `draw` MUST return a Node. `() => {}` is an arrow with an EMPTY BLOCK body, so it
      // returned `undefined`, and that broke the Overlayer's central invariant: every entry in its `#map`
      // must hold an `element` that is a real child of the overlay `<svg>`.
      //
      // WHAT ACTUALLY HAPPENED (proven, not inferred). `Overlayer.add` does
      //     const element = draw(rects, options); this.#svg.append(element); this.#map.set(key, { element })
      // so `undefined` was appended as the literal TEXT NODE "undefined" and stored as the entry's element.
      // `Overlayer.redraw()` then walks every entry doing `this.#svg.removeChild(element)` — with no
      // try/catch — so it threw `TypeError: parameter 1 is not of type 'Node'` AND ABORTED THE LOOP.
      //
      // THE ABORT IS THE REAL BUG, and it is why this is one root cause rather than one cosmetic error:
      // the overlayer is SHARED. Sard's highlights, the RAWY-281 reference twin rules, the TTS reading
      // spotlight (READING_KEY) and the karaoke word pill (WORD_KEY) all live in the SAME `#map` as the
      // search hits. Whichever of them sit after the first poisoned entry in insertion order were never
      // redrawn after any re-layout, keeping stale geometry from the previous layout.
      // MEASURED: with search results present, ONE alignment change threw exactly ONE exception — one per
      // redraw, not one per poisoned entry, which is the signature of the loop aborting at the first.
      // Without a prior search the same churn threw ZERO.
      //
      // Re-layout is triggered by far more than alignment: font, line-height, letter/paragraph spacing,
      // zoom, first-line indent, theme re-inject, page-opacity/background, immersive toggling, flow
      // switching and window resize all reach `paginator.expand()` -> `Overlayer.redraw()`.
      //
      // THE FIX IS AT THE VIOLATION, NOT THE SYMPTOM: return a real but EMPTY <g>. It satisfies the
      // contract, paints nothing (no children), and keeps the intent — the engine still draws no
      // per-match outline, because Sard does its own flash on jump. `createElementNS` from the top-level
      // document is exactly what foliate's own `createSVGElement` does, so the node is of the same kind
      // the Overlayer creates for every other entry.
      // Sard's four real draw functions are all TYPED `: SVGGElement`, so the compiler already guarantees
      // they return a node; this inline callback was the one untyped path and the only violator.
      const drawNothing = () => document.createElementNS("http://www.w3.org/2000/svg", "g");
      for await (const r of view.search({ query: q, draw: drawNothing })) {
        if (opts.signal?.aborted) break;
        if (r === "done") break;
        const now = performance.now();
        if (now - lastYield > 30) {
          await new Promise<void>((res) => setTimeout(res, 0));
          lastYield = performance.now();
        }
        if (typeof (r as any).progress === "number") {
          scanFrac = (r as any).progress;
          curIndex = Math.max(0, Math.round(scanFrac * n) - 1);
          emit(false);
          continue;
        }
        const rr = r as any;
        if (Array.isArray(rr.subitems)) {
          for (const s of rr.subitems) {
            if (!s?.cfi) continue;
            hits.push({
              cfi: s.cfi,
              sectionIndex: curIndex,
              chapterLabel: rr.label ?? "",
              pre: s.excerpt?.pre ?? "",
              match: s.excerpt?.match ?? "",
              post: s.excerpt?.post ?? "",
              frac: fractions[curIndex] ?? 0,
              ahead: boundary && compare ? compare(s.cfi, boundary) > 0 : false,
            });
          }
          emit(false);
        }
      }
    } catch {
      /* a superseded/cancelled search — return what we have */
    } finally {
      try { view.clearSearch?.(); } catch { /* ignore */ }
    }
    return hits;
  }

  /** RAWY-88: jump to a search hit and flash it (gold highlight for ~2s, then fade) — the panel stays
   *  open for stepping through results. */
  private flashTimer = 0;
  private flashRemove: (() => void) | null = null; // RAWY-138/139: removes the live flash (any draw path)
  private searchNavGen = 0; // RAWY-138: supersede an in-flight hit when a newer result is clicked
  async goToSearchHit(cfi: string, excerpt?: { pre: string; match: string; post: string }): Promise<void> {
    const view = this.view;
    if (!view) return;
    const gen = ++this.searchNavGen; // RAWY-138: this call's generation — a newer click bumps it
    // RAWY-138: drop the PREVIOUS flash immediately so rapid stepping never stacks stale gold overlays
    // (the old flashTimer only cancelled its own removal, leaving earlier flashes on screen forever).
    if (this.flashTimer) { clearTimeout(this.flashTimer); this.flashTimer = 0; }
    if (this.flashRemove) { try { this.flashRemove(); } catch { /* ignore */ } this.flashRemove = null; }
    const v = view as unknown as {
      goTo?: (c: string) => Promise<{ index: number } | undefined>;
      resolveNavigation?: (c: string) => { index: number; anchor?: (d: Document) => unknown } | undefined;
      renderer?: {
        getContents?: () => {
          index: number;
          doc?: Document;
          overlayer?: { add?: (k: string, r: Range, d: unknown, o: unknown) => void; remove?: (k: string) => void };
        }[];
        scrollToAnchor?: (a: Range, select?: boolean) => unknown;
      };
      addAnnotation?: (a: { value: string; color: string }) => void;
      deleteAnnotation?: (a: { value: string; color: string }) => void;
    };
    // 1) NAVIGATE — first and UNCONDITIONALLY; the jump never awaits fonts, so a result is reached at once.
    await v.goTo?.(cfi);
    if (gen !== this.searchNavGen) return; // a newer result was clicked — don't settle/flash a stale hit
    // 2) Resolve the hit's RANGE in the rendered doc. The search CFI is computed on foliate's raw
    // `createDocument()`, but the RENDERED doc's structure differs (RAWY-70's hide-first-line placeholder is
    // inserted, etc.), so the CFI's element/offset can point at the WRONG node — `CFI.toRange` then throws
    // (→ the gold flash is silently skipped, the owner's "jumped but no highlight") or resolves to the wrong
    // text. So PREFER re-finding the hit's exact text in the rendered doc (findMatchRange, tolerant of
    // tashkil/spacing); the CFI is only a last-resort fallback. resolveNavigation gives the section index
    // reliably (only anchor(doc) throws, not the index lookup).
    const nav = v.resolveNavigation?.(cfi);
    const doc = nav ? v.renderer?.getContents?.().find((x) => x.index === nav.index)?.doc : undefined;
    let range: Range | null = null;
    if (doc && excerpt) range = findMatchRange(doc, excerpt.pre, excerpt.match, excerpt.post);
    if (range) {
      // Found the exact text — scroll to it so the passage is actually shown at the hit (goTo landed on
      // the CFI's — possibly wrong — position, or failed to scroll at all when the CFI was out of bounds).
      try { v.renderer?.scrollToAnchor?.(range); } catch { /* ignore */ }
    } else {
      // No excerpt / text not found → best-effort CFI range (may be off, but better than nothing).
      try {
        if (doc && typeof nav?.anchor === "function") {
          const a = nav.anchor(doc);
          if (a instanceof Range && !a.collapsed) range = a;
        }
      } catch {
        /* CFI out of bounds in the rendered doc — leave range null; addAnnotation fallback below */
      }
    }
    // 3) SETTLE the target font before drawing (RAWY-137: draw on POST-reflow geometry so the flash lands on
    // the text — the range moves with the text as the font loads). It must NEVER block or hang the navigation
    // (RAWY-138): a section that UNLOADS mid-await leaves a `fonts.ready` that never resolves, and rapid clicks
    // would pile up pending awaits. So race `fonts.ready` against a short timeout (it resolves at once if the
    // font is already loaded — RAWY-137's correct first paint) and bail the instant a newer hit supersedes.
    try {
      const fontsReady = doc?.fonts?.ready ?? Promise.resolve();
      await Promise.race([fontsReady, new Promise<void>((r) => setTimeout(r, 500))]);
      if (gen !== this.searchNavGen) return;
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
      if (gen !== this.searchNavGen) return;
    } catch {
      /* settle is best-effort */
    }
    if (gen !== this.searchNavGen) return;
    // RAWY-249 (PART 1): centre the hit in the viewport — foliate's scrollToAnchor above LANDS IT AT THE TOP
    // (#scrollToRect: offset = rectLeft − #margin), which the owner reported as "the result shows at the top,
    // not the middle." Done AFTER the font settle so it centres the FINAL geometry, and before the flash so
    // the flash lands on the centred rect. Scrolled flow only (paged is page-indexed — DECISIONS D63).
    if (range) this.centerRangeInView(nav?.index ?? -1, range);
    if (gen !== this.searchNavGen) return;
    // 4) DRAW the flash on the resolved range, DIRECTLY on the section's overlayer (the same overlayer.add
    // `view.addAnnotation` reaches, minus the throwing CFI re-resolution), so it ALWAYS appears. Only fall
    // back to `view.addAnnotation` when we have no range at all.
    try {
      const ct = nav ? v.renderer?.getContents?.().find((x) => x.index === nav.index && x.overlayer) : undefined;
      if (range && ct?.overlayer?.add) {
        const overlayer = ct.overlayer;
        overlayer.add?.(cfi, wordRectRange(range) as unknown as Range, drawHighlight, { color: this.resolveColor("#E8C36A"), dark: this.theme?.dark ?? false, paper: this.inkPaper }); // RAWY-258: same geometry + ink as a saved highlight
        this.flashRemove = () => { try { overlayer.remove?.(cfi); } catch { /* ignore */ } };
      } else {
        const item = { value: cfi, color: "#E8C36A" }; // gold ink (design) — resolveColor passes hex through
        v.addAnnotation?.(item);
        this.flashRemove = () => { try { v.deleteAnnotation?.(item); } catch { /* ignore */ } };
      }
      const removeFn = this.flashRemove;
      this.flashTimer = window.setTimeout(() => {
        try { removeFn?.(); } catch { /* ignore */ }
        if (this.flashRemove === removeFn) this.flashRemove = null;
      }, 2000);
    } catch {
      /* flash is best-effort */
    }
  }
  /** DEV: jump to a TOC entry by index or 'last' (investigation/verification helper). */
  goToTocEntry(which: "last" | number): Promise<unknown> | undefined {
    const toc = this.getToc().filter((t) => t.href);
    if (!toc.length) return;
    const i = which === "last" ? toc.length - 1 : Math.max(0, Math.min(toc.length - 1, which));
    return this.goToHref(toc[i].href as string);
  }
  /** DEV: snapshot the current section's layout to explain rendering bugs. */
  diagnose(): string {
    if (this.isFixedLayout) {
      // RAWY-87 investigation: is the PDF page fit-page (no intra-page scroll) or scrollable? Measure
      // the foliate-fxl host (overflow:auto) + the page iframe body.
      const r: any = this.view?.renderer;
      const idoc: Document | undefined = r?.getContents?.()?.[0]?.doc;
      const ibody = idoc?.body;
      return JSON.stringify({
        fxl: true,
        pageIndex: this.pdfPageIndex,
        pageCount: this.pdfPageCount,
        host: { clientH: r?.clientHeight, scrollH: r?.scrollHeight, scrollTop: r?.scrollTop, clientW: r?.clientWidth, scrollW: r?.scrollWidth },
        iframeBody: ibody ? { scrollH: ibody.scrollHeight, clientH: ibody.clientHeight } : null,
      });
    }
    const c = this.view?.renderer?.getContents?.()?.[0];
    const doc: Document | undefined = c?.doc;
    const body = doc?.body;
    if (!body) return "no section";
    const kids = Array.from(body.children).slice(0, 8).map((e) => e.tagName + (e.getAttribute("class") ? "." + e.getAttribute("class") : ""));
    const heads = Array.from(body.querySelectorAll("h1,h2"));
    const headInfo = heads.slice(0, 4).map((h) => {
      const cs = doc!.defaultView!.getComputedStyle(h);
      return { tag: h.tagName, display: cs.display, columnSpan: (cs as any).columnSpan ?? cs.getPropertyValue("column-span"), txt: (h.textContent ?? "").slice(0, 18) };
    });
    return JSON.stringify({ index: c?.index, scrollW: body.scrollWidth, clientW: body.clientWidth, scrollH: body.scrollHeight, headings: heads.length, firstKids: kids, headInfo });
  }
  onRelocate(cb: (info: RelocateInfo) => void): void {
    this.relocateCb = cb;
  }
  get dir(): string | undefined {
    return this.forcedDir ?? this.view?.book?.dir;
  }
  /** Book title from the EPUB metadata (RAWY-33 — shown in the reading-chrome nav block). */
  get title(): string | undefined {
    const t = this.view?.book?.metadata?.title;
    if (!t) return undefined;
    return typeof t === "string" ? t : (t.value ?? t["#text"] ?? undefined);
  }
  /** Book author/creator from the EPUB metadata (RAWY-49 — the photo-card credit line).
   *  foliate normalises author to a string, an object with `name`, or an array of either. */
  get author(): string | undefined {
    const a = (this.view?.book?.metadata as { author?: unknown } | undefined)?.author;
    if (!a) return undefined;
    const one = (v: unknown): string | undefined =>
      typeof v === "string" ? v : (v as { name?: string })?.name;
    if (Array.isArray(a)) return a.map(one).filter(Boolean).join("، ") || undefined;
    return one(a);
  }


  // ---------------------------------------------------------------------------
  // RAWY-260 — REFERENCES: mark every occurrence of a referenced phrase, per section.
  // ---------------------------------------------------------------------------

  /** The book's references, loaded once on open. Small (tens per book), so kept in memory and re-used for
   *  every section instead of re-queried. */
  private refs: RefLite[] = [];
  /** Per rendered section: the Ranges we marked and which reference each belongs to — the click hit-test
   *  reads this, so a tap can resolve to a reference without re-scanning any text. Keyed by section index
   *  and dropped when that section unloads with the document. */
  private refRanges = new Map<number, { range: Range; refId: string }[]>();

  /** Replace the reference set and re-mark every section currently rendered (a save/delete is immediate —
   *  a deleted reference's marks must vanish at once, and they do because nothing was ever written into
   *  the document: dropping the range from the registry IS the removal). */
  setReferences(list: RefLite[]): void {
    this.refs = list;
    const contents = this.view?.renderer?.getContents?.() as { index: number; doc?: Document }[] | undefined;
    for (const c of contents ?? []) {
      if (c?.doc) this.applyReferences(c.doc, c.index);
    }
  }

  /**
   * Mark this section's occurrences. Walks the section's text nodes ONCE, building the folded haystack and
   * a per-character map back to (node, offset) — the same technique `findMatchRange` uses for search hits —
   * then asks the matching engine for whole-phrase hits and registers them as one CSS Custom Highlight.
   *
   * PERFORMANCE: this is per SECTION, on load. The whole book is never rescanned, so a 1400-chapter EPUB
   * costs exactly what the chapter on screen costs; and because the folded text is built in one pass, the
   * work is linear in the section's length regardless of how many references exist.
   */
  /**
   * RAWY-FINAL (leak fix): drop registry entries for sections that are no longer laid out.
   *
   * The field's own doc-comment claimed entries were "dropped when that section unloads with the
   * document" — NO SUCH CODE EXISTED. The only delete was for the index being re-marked, so in a book
   * with references the map grew by one entry per distinct section visited and was never reduced;
   * `dispose()` did not clear it either. Each retained entry holds DOM `Range`s, and a Range keeps its
   * start/end `Text` nodes — and therefore their ancestor chain and owner `Document` — alive. foliate
   * destroys a section's iframe document when you navigate away, so the result was one DETACHED DOM
   * TREE pinned per visited section, for the whole session. On a 1,400-chapter book that is unbounded.
   *
   * The live set is taken from the renderer's own `getContents()`, which is EXACTLY the set
   * `referenceAtPoint` resolves an index from — so pruning to it cannot make a hit-test miss. `keep` is
   * forced in because `applyReferences` runs from the `load` handler and must not evict the section it
   * is in the middle of marking, whether or not the renderer has published it yet.
   */
  private pruneRefRanges(keep: number): void {
    const live = new Set<number>([keep]);
    const contents = this.view?.renderer?.getContents?.() as { index?: number }[] | undefined;
    for (const c of contents ?? []) if (typeof c?.index === "number") live.add(c.index);
    for (const idx of Array.from(this.refRanges.keys())) {
      if (!live.has(idx)) this.refRanges.delete(idx);
    }
    // RAWY-281: the paint bookkeeping follows the ranges exactly. A section that has unloaded took its
    // overlayer with it, so its keys can never be removed and must not be remembered.
    for (const idx of Array.from(this.prevRefKeys.keys())) {
      if (!live.has(idx)) this.prevRefKeys.delete(idx);
    }
  }

  private applyReferences(doc: Document, index: number): void {
    // RAWY-276: prune FIRST, unconditionally, so the ranges of sections that have unloaded are released
    // on every path out of this method — including the early returns below.
    this.pruneRefRanges(index);
    this.refRanges.delete(index);
    if (!this.refs.length) {
      this.drawReferences(index);
      return;
    }
    // ONE pass over the text: fold per character (memoised, RAWY-178) and remember where each folded char
    // came from, so a hit's [start,end) maps straight back to a DOM Range with no second walk.
    let hay = "";
    const nodes: Text[] = [];
    const offs: number[] = [];
    try {
      const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
      let n: Node | null;
      while ((n = walker.nextNode())) {
        const t = n as Text;
        const s = t.data;
        for (let i = 0; i < s.length; i++) {
          const fc = foldChar(s[i]);
          for (let k = 0; k < fc.length; k++) { hay += fc[k]; nodes.push(t); offs.push(i); }
        }
      }
    } catch {
      return; // a torn-down section — nothing to mark
    }
    const hits = findPhraseHits(hay, this.refs);
    if (!hits.length) {
      this.drawReferences(index);
      return;
    }
    const marked: { range: Range; refId: string }[] = [];
    for (const h of hits) {
      if (h.start >= nodes.length) continue;
      try {
        const r = doc.createRange();
        r.setStart(nodes[h.start], offs[h.start]);
        if (h.end < nodes.length) r.setEnd(nodes[h.end], offs[h.end]);
        else { const last = nodes[nodes.length - 1]; r.setEnd(last, last.data.length); }
        if (!r.collapsed) marked.push({ range: r, refId: h.refId });
      } catch {
        /* offsets shifted under us — skip this occurrence rather than fail the whole section */
      }
    }
    this.refRanges.set(index, marked);
    this.drawReferences(index);
  }

  /**
   * RAWY-281: paint the twin rule for every marked occurrence in the rendered sections.
   *
   * ⚠️ ORDERING — WHY THIS IS NOT SIMPLY DONE AT `load`. `applyReferences` runs from the `load` handler,
   * and at that moment the section's overlayer DOES NOT EXIST YET: foliate's paginator awaits
   * `view.load()` (which is what fires `load`) and only THEN dispatches `create-overlayer`
   * (paginator.js:1011). So the draw is attempted from BOTH ends — here, for every case where the
   * overlayer is already up (a reference saved or deleted while reading, a settings change, a theme
   * change), and again from the `create-overlay` handler for the first paint of a freshly rendered
   * section. A miss is harmless because there is no state to lose: the mark is derived entirely from
   * `refRanges`, so whichever call finds an overlayer draws the same thing.
   *
   * `index` narrows the work to one section; omitted, every rendered section is repainted (paged mode
   * lays out more than one at a time, so a colour change must reach all of them).
   */
  private drawReferences(index?: number): void {
    const contents = this.view?.renderer?.getContents?.() as
      | {
          index?: number;
          overlayer?: {
            add?: (k: string, r: unknown, d: unknown, o: unknown) => void;
            remove?: (k: string) => void;
            element?: SVGSVGElement;
          };
        }[]
      | undefined;
    if (!contents?.length) return;
    const accent = this.theme?.colors?.accent ?? "#9C5A3C";
    // The design: "Colour is the theme accent at 100% — no opacity anywhere, since that is what made the
    // old mark disappear." A per-book override replaces the accent outright; nothing dilutes either.
    const color = this.style?.refRuleColor ?? accent;
    for (const c of contents) {
      const overlayer = c.overlayer;
      if (!overlayer?.add || !overlayer.remove || typeof c.index !== "number") continue;
      if (index != null && c.index !== index) continue;
      const marked = this.refRanges.get(c.index) ?? [];
      // Clear the PREVIOUS paint before re-adding. The count can shrink (a reference was deleted, or the
      // reader edited the phrase so it matches fewer places), so removing exactly what is about to be
      // re-added would strand the tail — `prevRefKeys` is what makes the clear complete rather than
      // approximate. `Overlayer.remove` is a no-op for a key it does not hold, so this is safe blind.
      for (const key of this.prevRefKeys.get(c.index) ?? []) {
        try { overlayer.remove(key); } catch { /* the section is going away — nothing to clean */ }
      }
      const keys: string[] = [];
      for (let i = 0; i < marked.length; i++) {
        const key = `${REF_KEY_PREFIX}${c.index}:${i}`;
        try {
          // The PROXY, not the raw Range — it re-measures the strokes on every `Overlayer.redraw()`
          // (font load, resize, zoom) exactly as a real Range would. Both the proxy's `style` and the
          // draw's `color` are captured NOW, which is why a settings or theme change has to re-add rather
          // than rely on the options the overlayer already holds.
          overlayer.add(key, refRuleRange(marked[i].range, this.style, overlayer.element ?? null), drawRefRule, { color });
          keys.push(key);
        } catch {
          /* a stale range in a section being torn down — skip this one, keep the rest */
        }
      }
      if (keys.length) this.prevRefKeys.set(c.index, keys);
      else this.prevRefKeys.delete(c.index);
    }
  }

  /** The overlayer keys the last paint used, per section — see `drawReferences` for why the count cannot
   *  be re-derived from `refRanges` at clear time. Pruned with `refRanges` and cleared on `dispose()`;
   *  it holds only short strings, never a Range or a Node, so it can never pin a document (RAWY-276). */
  private prevRefKeys = new Map<number, string[]>();

  /** RAWY-260: which reference (if any) sits under this point in the CURRENT section? Hit-tests the ranges
   *  we already stored, so a tap costs a few rect comparisons and never a text scan. Returns the reference
   *  id plus the occurrence's rect in PARENT-viewport coords, which is what positions the popup. */
  /** RAWY-262 (UX EXPERIMENT): which STORED highlight, if any, is under this point? `x`/`y` must be in
   *  the CONTENT document's own space (raw clientX/clientY of an event inside the reading iframe) — the
   *  same coordinate rule referenceAtPoint documents below, and for the same reason: that is the space
   *  the overlayer's rects are in. The parent-space conversion happens at the END, on the matched rect
   *  only, because that is what anchors the editor in the chrome layer.
   *
   *  Delegates to the overlayer's OWN hitTest — the identical call foliate's single-click path made — so
   *  the hit area is exactly the painted mark (RAWY-258 word rects included), a multi-line highlight is
   *  hit on any of its line fragments, and two adjacent highlights resolve to different keys. No overlay
   *  element is created and the EPUB DOM is not touched: the geometry is the overlayer's existing rects.
   *
   *  The overlayer also holds NON-highlight keys — the transient TTS reading band/pill (RAWY-126) and the
   *  RAWY-249 search flash — so the result is gated on `annotations`, the map of highlights Sard actually
   *  stores. That gate is what keeps this experiment scoped to highlights: references (Custom Highlight
   *  API, not the overlayer), notes, bookmarks and search results can never satisfy it. */
  highlightAtPoint(doc: Document, x: number, y: number): AnnotationHit | null {
    const contents = this.view?.renderer?.getContents?.() as
      | { doc?: Document; overlayer?: { hitTest?: (p: { x: number; y: number }) => [string?, MarkGeometry?] } }[]
      | undefined;
    // Looked up by the DOCUMENT that was clicked, not by currentSectionIndex(): in paged mode more than
    // one section can be laid out at once, and the clicked doc is unambiguous (same rule as references).
    const overlayer = contents?.find((c) => c.doc === doc)?.overlayer;
    const [key, mark] = overlayer?.hitTest?.({ x, y }) ?? [];
    if (!key || !mark) return null;
    if (!this.annotations.has(key)) {
      return null; // an overlay, not a stored highlight — not editable
    }
    // ⚠️ THE ORIGINAL DEFECT (RAWY-262). This line used to call `mark.getBoundingClientRect()`, which
    // threw `TypeError: ... is not a function` on EVERY real highlight and aborted the listener before it
    // could open anything. The overlayer stores whatever was handed to `add`, and on Sard's normal draw
    // path that is RAWY-258's `wordRectRange` PROXY — `{ getClientRects, toString }`, deliberately not a
    // Range (FoliateController.ts:209). Only foliate's own fallback `draw` (view.js:392) stores a real
    // Range, so the ONE path that worked was the one that almost never runs.
    // Deriving the box from `getClientRects()` is what both shapes support, so the anchor no longer
    // depends on which draw path happened to run — and the union of the line rects IS the bounding box,
    // so the editor anchors exactly where the single-click path used to put it.
    const rect = unionRect(mark.getClientRects());
    if (!rect) return null;
    return { cfi: key, rect: this.rectInParent(rect, doc) };
  }

  referenceAtPoint(doc: Document, x: number, y: number): { refId: string; rect: AnchorRect } | null {
    // ⚠️ COORDINATE SPACE — the bug this method originally shipped with. `x`/`y` MUST be in the CONTENT
    // document's own space (i.e. the raw clientX/clientY of a click inside the reading iframe), because
    // that is the space `Range.getClientRects()` reports in. Converting the click to parent-viewport
    // coords first — as the click handler used to — compares a point against rects from a different
    // origin, offset by wherever the reading frame sits in the page (tens to hundreds of px), so a tap on
    // a marked word tested a point far away from it and never matched. The PARENT-space conversion belongs
    // at the END, on the matched rect only, because that is what positions the popup in the chrome layer.
    //
    // The ranges are looked up by the DOCUMENT that was clicked, not by `currentSectionIndex()`: in paged
    // mode more than one section can be laid out at once, and the clicked doc is unambiguous.
    const contents = this.view?.renderer?.getContents?.() as { index: number; doc?: Document }[] | undefined;
    const idx = contents?.find((c) => c.doc === doc)?.index ?? this.currentSectionIndex();
    const marked = this.refRanges.get(idx);
    if (!marked?.length) return null;
    for (const m of marked) {
      for (const raw of Array.from(m.range.getClientRects())) {
        if (!(raw.width > 0) || !(raw.height > 0)) continue;
        // The mark is drawn BELOW the glyph box, so a tap aimed at the visible rules lands outside the
        // range's own rect and the target has to be the word AND its rules. RAWY-281: the pair's reach is
        // no longer a constant — it is the design's clearance plus both strokes plus the gap, and the
        // reader can scale all of it — so the bottom slack is COMPUTED from the same resolver the draw
        // uses rather than guessed. A fixed 4px was already short of the design's default pair (~7px at
        // reading size) and would have missed the mark entirely at the top of the offset range.
        // The SAME em basis the draw uses (`emPxForRange`, falling back to the rect estimate) — if these
        // two ever diverge the tap target stops matching the painted mark, which is the exact class of
        // bug that made this hit-test wrong in RAWY-260.
        const reach = refRuleReach(
          resolveRefRule(
            this.style ?? undefined,
            this.theme?.colors?.accent ?? "#9C5A3C",
            emPxForRange(m.range) ?? raw.height / INK_EM,
          ),
        );
        if (
          x >= raw.left - REF_HIT_SLACK_PX &&
          x <= raw.right + REF_HIT_SLACK_PX &&
          y >= raw.top - REF_HIT_SLACK_PX &&
          y <= raw.bottom + reach + REF_HIT_SLACK_PX
        ) {
          return { refId: m.refId, rect: this.rectInParent(raw, doc) };
        }
      }
    }
    return null;
  }

  /** Fired when the reader taps a marked phrase — the Reader opens the popup on it. */
  onReferenceHit(cb: (hit: { refId: string; rect: AnchorRect }) => void): void {
    this.referenceCb = cb;
  }
  private referenceCb: ((hit: { refId: string; rect: AnchorRect }) => void) | null = null;

  /** RAWY-85: a fixed-layout book (a PDF) — read-only, no injected typography/theme. */
  get isFixedLayout(): boolean {
    return this.view?.book?.rendition?.layout === "pre-paginated";
  }
  /** RAWY-85: the page-1 cover as PNG bytes (PDF adapter's getCover), for library enrichment.
   *  RAWY-177 (AUD-4): return the raw ArrayBuffer — the ipc layer stages it, so no per-byte JS array. */
  async getCoverBytes(): Promise<ArrayBuffer | null> {
    try {
      const blob: Blob | undefined = await this.view?.book?.getCover?.();
      if (!blob) return null;
      return await blob.arrayBuffer();
    } catch {
      return null;
    }
  }
}
