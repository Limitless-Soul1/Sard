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
  ALIGN_GATE_CLASS,
  BOOK_ALIGN_CLASS,
  type BookThemeFlags,
  type ReadingStyle,
  type RevealLabels,
} from "./injectedCss";
import type { Theme } from "../theme/tokens";
import { extractChapterNumber, toWesternDigits } from "../lib/format";

// RAWY-140: the per-doc PAINT sheet marker. buildDynamicCss's ink/tashkīl/scrollbar rules live in a
// <style data-sard-dyn> appended AFTER foliate's own sheet, so colour/tashkīl changes update it in
// place (a repaint) instead of re-injecting the whole sheet (foliate's setStyles → @font-face
// re-declare + expand() → the flash/jump).
const DYN_ATTR = "data-sard-dyn";
// Reading-style fields that only affect PAINT (ink colour, tashkīl visibility) — applied via the
// dynamic sheet with NO reflow. Every other field that appears in buildReadingCss (fonts, size/zoom,
// line-height, alignment, weight, spacing, flow) is GEOMETRY → a real re-inject. Fields absent from
// both lists (marginPx, pageWidth, pageFitWindow) are chrome-side (RAWY-36) — they touch neither.
const PAINT_STYLE_KEYS: (keyof ReadingStyle)[] = ["textColor", "diacritics"];
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

export interface RelocateInfo {
  cfi: string | null;
  fraction: number;
  chapterLabel: string | null;
  chapterHref: string | null;
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
}
export interface AnnotationHit {
  cfi: string;
  rect: AnchorRect;
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
function drawHighlight(rects: Iterable<DOMRect>, options: { color?: string; dark?: boolean } = {}): SVGGElement {
  const NS = "http://www.w3.org/2000/svg";
  const g = document.createElementNS(NS, "g");
  g.setAttribute("fill", options.color ?? "#E8C36A");
  // Intensity + "wick into the paper" blend, applied DIRECTLY (RAWY-22) rather than via an
  // inherited CSS var — the SVG <g> is created in the parent doc and adopted into foliate's
  // overlayer, and the var didn't reliably reach it (it fell back to multiply → invisible on
  // black). Light paper: multiply; dark paper: screen so the ink lifts off the page.
  g.style.opacity = options.dark ? "0.7" : "0.62";
  g.style.mixBlendMode = options.dark ? "screen" : "multiply";
  for (const r of rects) {
    const rect = document.createElementNS(NS, "rect");
    rect.setAttribute("x", String(r.left));
    rect.setAttribute("y", String(r.top));
    rect.setAttribute("height", String(r.height));
    rect.setAttribute("width", String(r.width));
    g.append(rect);
  }
  return g;
}

// RAWY-126 (TTS reading indicator, Phase 1 — design 1b "Spotlight"): the currently-SPOKEN sentence
// gets a SOFT WARM TRACK — a low-opacity terracotta band + a thin baseline rule the eye follows.
// Deliberately NOT the ink look: no mix-blend-mode (the 8 highlight washes use multiply/screen at
// 0.62/0.70), a much lower fill opacity, and a baseline rule no ink wash has — so it reads as a
// "reading cursor," never as one of the user's saved highlights. Brand terracotta (light) / a
// lighter warm (dark), matching the on-disk design 1b; the solid word "pill" is Phase 2, not here.
// The overlay key is RESERVED (READING_KEY) and the draw goes straight to the section overlayer —
// it never enters the persisted annotations map or the DB.
const READING_KEY = "sard-reading";
const READING_SPOTLIGHT = {
  light: { fill: "rgb(156,90,60)", band: 0.1, rule: 0.3 }, // #9C5A3C — the brand terracotta
  dark: { fill: "rgb(201,138,94)", band: 0.16, rule: 0.44 }, // #C98A5E — a lighter warm for dark paper
};
function drawReadingSpotlight(rects: Iterable<DOMRect>, options: { dark?: boolean } = {}): SVGGElement {
  const NS = "http://www.w3.org/2000/svg";
  const g = document.createElementNS(NS, "g");
  const p = options.dark ? READING_SPOTLIGHT.dark : READING_SPOTLIGHT.light;
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
    // thin baseline rule the eye follows
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
const READING_PILL = {
  light: { fill: "rgb(156,90,60)", op: 0.9, blend: "multiply" }, // #9C5A3C on paper → rich terracotta
  dark: { fill: "rgb(201,138,94)", op: 0.9, blend: "screen" }, // #C98A5E lifts off dark paper
};
function drawReadingPill(rects: Iterable<DOMRect>, options: { dark?: boolean } = {}): SVGGElement {
  const NS = "http://www.w3.org/2000/svg";
  const g = document.createElementNS(NS, "g");
  const p = options.dark ? READING_PILL.dark : READING_PILL.light;
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
    if (v) {
      try {
        v.close?.();
      } catch {
        /* ignore */
      }
      v.remove?.();
    }
  }

  /** Open `source` into `container`. Idempotent — disposes any prior view first. */
  async open(source: string, container: HTMLElement, opts: OpenOptions): Promise<void> {
    this.dispose();
    await ensureFoliateDefined();

    const view = document.createElement("foliate-view") as any;
    this.view = view; // claim ownership before awaits; a later open() will replace this
    container.replaceChildren(view);

    await view.open(source);
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
      this.relocateCb?.({
        cfi,
        fraction,
        chapterLabel: e.detail?.tocItem?.label ?? null,
        chapterHref: e.detail?.tocItem?.href ?? null,
      });
    });
    view.addEventListener("load", (e: any) => {
      const doc: Document | undefined = e.detail?.doc;
      const index: number = e.detail?.index ?? 0;
      if (!doc) return;
      // RAWY-86: a PDF page is a rendered image + a pdf.js text layer — none of the EPUB-content
      // machinery (tashkīl wrapping, in-body heading marking, the reveal, boundary-scroll) applies.
      // Capture the page doc (for copy) + keep arrow-key paging + chrome-wake activity; skip the rest.
      if (fxl) {
        this.pdfPageDoc = doc;
        doc.addEventListener("keydown", (ev: KeyboardEvent) => {
          if (ev.key === "ArrowLeft" || ev.key === "ArrowUp" || ev.key === "PageUp") this.view?.prev?.();
          // RAWY-180 (Part B): Space toggles read-aloud when active; else it pages the PDF (as before).
          else if (ev.key === " ") { if (this.spaceCb?.()) ev.preventDefault(); else this.view?.next?.(); }
          else if (ev.key === "ArrowRight" || ev.key === "ArrowDown" || ev.key === "PageDown") this.view?.next?.();
        });
        // RAWY-87 (#2): a wheel over the PDF PAGE fires INSIDE this iframe, so it never reaches the
        // reader-desk's onWheel (the frame boundary) — that's why wheeling the page did nothing while
        // the margins (which DO reach the desk → pageByWheel) turned pages. Forward the page's own
        // wheel to the SAME pageByWheel path, so a wheel anywhere in the reading area pages the PDF.
        // The two paths are mutually exclusive per physical wheel (page XOR margin), so no double-turn;
        // the page is fit-to-view (no native scroll to fight), so this is passive with no preventDefault.
        doc.addEventListener("wheel", (ev: WheelEvent) => this.pageByWheel(ev.deltaY), { passive: true });
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
      this.writeDynamic(doc); // RAWY-140: this section's in-place PAINT sheet (colour/tashkīl skip re-inject)
      markInBodyHeading(doc, sectionTocLabel(view, index)); // RAWY-67: hide-titles catches this too
      // RAWY-195: measure the book's OWN alignment and open the alignment gate. Must run before
      // anything paints, and before alignNeutralLines (which sets dir=, not text-align, but keep the
      // pristine document for the measurement anyway).
      markBookAlignedBlocks(doc, this.dir);
      alignNeutralLines(doc, this.dir); // RAWY-134 (A): "…"-only scene breaks follow the book's RTL side
      // RAWY-70: the two-step reveal for the hide-first-line placeholder. Handled from the parent
      // frame (the content iframe runs no scripts, RAWY-64) via cross-frame DOM access, like the
      // handlers below. Per-instance + reset-on-navigation is automatic: each section is a fresh
      // doc with a fresh idle placeholder.
      doc.addEventListener("click", (ev: Event) => this.onRevealClick(ev));
      doc.addEventListener("keydown", (ev: KeyboardEvent) => {
        // RAWY-184 (Part C): while read-aloud is active, arrows skip the prev/next SENTENCE (the cb
        // returns true → swallow); otherwise they keep the normal page-turn (next/prev).
        if (ev.key === "ArrowLeft") { if (this.arrowCb?.("ArrowLeft")) ev.preventDefault(); else this.next(); }
        else if (ev.key === "ArrowRight") { if (this.arrowCb?.("ArrowRight")) ev.preventDefault(); else this.prev(); }
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
      // Scrolled mode: the chapter-boundary "new gesture to advance" handler (RAWY-25).
      if (this.scrolledMode)
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
        this.selectionCb?.({ cfi, text, rect: this.rectInParent(range.getBoundingClientRect(), doc) });
      });
    });

    // Highlights: draw on (re)render, re-apply per section, surface clicks (RAWY-20).
    view.addEventListener("draw-annotation", (e: any) => {
      const { draw, annotation } = e.detail;
      draw(drawHighlight, { color: this.resolveColor(annotation.color), dark: this.theme?.dark ?? false });
    });
    view.addEventListener("show-annotation", (e: any) => {
      const { value, index, range } = e.detail;
      // RAWY-132: the TTS reading indicators (sard-reading / sard-reading-word) are transient overlays,
      // NOT annotations — but the overlayer's geometric hitTest still emits show-annotation when a click
      // lands within the reading band's rects (RAWY-126). Surfacing that as an annotation hit sets a
      // bogus active with no popover AND skips clearSelection, so a click on the reading text could leave
      // a lingering selection that re-fires the toolbar. Treat a tap on a reading overlay like a tap on
      // plain text: dismiss the popover + clear the real selection, never emit an annotation hit.
      if (typeof value === "string" && value.startsWith("sard-reading")) {
        this.clearSelection();
        this.selectionCb?.(null);
        return;
      }
      this.showCb?.({ cfi: value, rect: this.rangeRectInParent(index, range) });
    });
    view.addEventListener("create-overlay", (e: any) => {
      for (const [cfi, color] of this.annotations) view.addAnnotation({ value: cfi, color });
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
    if (this.style)
      this.view?.renderer?.setStyles?.(
        buildReadingCss(this.style, this.theme, this.flags, this.dir, this.revealLabels),
      );
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
      this.applyDynamic();
      return;
    }
    const geom = GEOMETRY_STYLE_KEYS.some((k) => prev[k] !== style[k]);
    const paint = PAINT_STYLE_KEYS.some((k) => prev[k] !== style[k]);
    if (geom) this.reinject(); // inherent reflow — buildReadingCss also re-emits the fresh ink
    if (geom || paint) this.applyDynamic(); // colour/tashkīl in place (no @font-face, no expand)
  }

  /** Update theme colours + book flags (override-colour, hide-titles). */
  applyTheme(theme: Theme, flags: BookThemeFlags): void {
    this.theme = theme;
    this.flags = flags;
    this.reinject();
    this.applyDynamic(); // RAWY-140: theme ink → refresh the in-book PAINT sheet to match
    // Highlights store a semantic slot → re-draw them in the new theme's colours.
    for (const [cfi, color] of this.annotations) this.view?.addAnnotation({ value: cfi, color });
  }

  // ---- highlights / notes anchoring (RAWY-20) ----
  private resolveColor(color: string): string {
    if (/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(color)) return color; // custom hex
    const set = this.theme?.colors.highlight as Record<string, string> | undefined;
    return set?.[color] ?? HL_FALLBACK[color] ?? color;
  }
  private rectInParent(rect: DOMRect, doc: Document): AnchorRect {
    const fr = (doc.defaultView as Window & { frameElement?: Element })?.frameElement?.getBoundingClientRect();
    const ox = fr?.left ?? 0;
    const oy = fr?.top ?? 0;
    return { left: ox + rect.left, top: oy + rect.top, width: rect.width, height: rect.height, bottom: oy + rect.bottom };
  }
  private rangeRectInParent(index: number, range: Range): AnchorRect {
    const obj = this.view?.renderer?.getContents?.().find((x: any) => x.index === index);
    const doc: Document | undefined = obj?.doc;
    const rect = range.getBoundingClientRect();
    return doc ? this.rectInParent(rect, doc) : { left: rect.left, top: rect.top, width: rect.width, height: rect.height, bottom: rect.bottom };
  }

  onSelection(cb: (sel: SelectionInfo | null) => void): void {
    this.selectionCb = cb;
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
  async addHighlight(cfi: string, color: string): Promise<string | null> {
    this.annotations.set(cfi, color);
    const res = await this.view?.addAnnotation({ value: cfi, color });
    return res?.label ?? null;
  }
  removeHighlight(cfi: string): void {
    this.annotations.delete(cfi);
    this.view?.deleteAnnotation({ value: cfi });
  }
  setHighlightColor(cfi: string, color: string): void {
    this.annotations.set(cfi, color);
    this.view?.addAnnotation({ value: cfi, color }); // re-add → redraw new colour
  }
  async loadHighlights(list: { cfi: string; color: string }[]): Promise<void> {
    for (const h of list) {
      this.annotations.set(h.cfi, h.color);
      await this.view?.addAnnotation({ value: h.cfi, color: h.color });
    }
  }

  /** Is the reader currently in scrolled mode? */
  get isScrolled(): boolean {
    return this.scrolledMode;
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

  /** RAWY-162: map a saved TTS cursor back to a live sentence index to resume from. If it's in a
   *  DIFFERENT section, navigate there first (via the sentence CFI) so re-segmentation reads the right
   *  chapter; then resolve the index — prefer the saved `idx` when its text still matches `snip`, else
   *  search the units for `snip`, else clamp. Returns -1 if the chapter has no speakable units. */
  async prepareTtsResume(cursor: { cfi?: string; sec?: number; idx: number; snip?: string }, lang?: string): Promise<number> {
    if (cursor.cfi && cursor.sec !== this.currentSectionIndex()) {
      try { await this.goToLocator(cursor.cfi); } catch { /* bad/foreign cfi → fall through to same-section resolve */ }
    }
    const units = await this.getChapterUnits(lang);
    if (units.length === 0) return -1;
    const norm = (s: string) => s.replace(/\s+/g, " ").trim();
    const key = norm(cursor.snip ?? "").slice(0, 24);
    const at = cursor.idx;
    if (key && units[at] && norm(units[at].text).startsWith(key)) return at;
    if (key) {
      const k = units.findIndex((u) => norm(u.text).includes(key));
      if (k >= 0) return k;
    }
    return Math.min(Math.max(0, at), units.length - 1);
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
    if (!doc?.body || this.isFixedLayout) {
      this.ttsUnits = [];
      this.ttsUnitsIndex = -1;
      return [];
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
      // No visible leaf held text (text sits directly in <body>, or inline-only, or all-hidden) —
      // read the whole body so a full chapter is never empty, but WITHOUT ranges (honest no-highlight).
      const whole = norm(doc.body.textContent ?? "");
      if (hasSpeech(whole)) {
        if (seg) {
          for (const part of seg.segment(whole)) {
            const t = norm(part.segment);
            if (hasSpeech(t)) units.push({ text: t, range: null });
          }
        } else {
          units.push({ text: whole, range: null });
        }
      }
    }

    this.ttsUnits = units;
    this.ttsUnitsIndex = content?.index ?? -1;
    this.ttsLang = lang; // RAWY-129: remember it so a return-to-chapter rebuild segments identically
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
    // Walk segments in order; `sum`/`strIndex` advance monotonically over the concatenated nodes so
    // each sentence's char offsets resolve to the right node + offset (foliate tts.js technique).
    let strIndex = -1;
    let sum = 0;
    for (const { index, segment } of seg.segment(full)) {
      while (sum <= index) sum += strs[++strIndex].length;
      const startIndex = strIndex;
      const startOffset = index - (sum - strs[strIndex].length);
      const end = index + segment.length - 1;
      if (end < full.length) while (sum <= end) sum += strs[++strIndex].length;
      const endIndex = strIndex;
      const endOffset = end - (sum - strs[strIndex].length) + 1;
      const t = norm(segment);
      if (hasSpeech(t)) out.push({ text: t, range: makeRange(startIndex, startOffset, endIndex, endOffset) });
    }
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
    if (this.isFixedLayout) return;
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
    const range = this.ttsUnits[i]?.range;
    if (!range) return; // out of range / whole-body fallback → no highlight (honest)
    try {
      overlayer.add(READING_KEY, range, drawReadingSpotlight, { dark: this.theme?.dark ?? false });
    } catch {
      /* stale/detached range (chapter navigated mid-play) — skip silently */
    }
  }

  /** Remove the reading spotlight AND the word pill (stop / play closed / left the chapter). */
  clearReadingHighlight(): void {
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
    const range = w >= 0 ? this.wordRanges[w] : null;
    if (!range) return; // no word / unmapped → no pill (the sentence band still shows)
    try {
      overlayer.add(WORD_KEY, range, drawReadingPill, { dark: this.theme?.dark ?? false });
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
    if (!content || content.index !== this.ttsUnitsIndex) return;
    const range = this.ttsUnits[i]?.range;
    const doc: Document | undefined = content.doc;
    const r = this.view?.renderer;
    if (!range || !doc || !r) return;
    const raw = range.getBoundingClientRect();
    if (!(raw.width > 0) && !(raw.height > 0)) return; // not laid out yet
    const pr = this.rectInParent(raw, doc); // range rect in PARENT-viewport coords
    const rv = (r as Element).getBoundingClientRect?.(); // the visible reading box
    if (!rv || !(rv.height > 0)) return;
    if (this.scrolledMode) {
      const comfortTop = rv.top + rv.height * 0.15;
      const comfortBottom = rv.top + rv.height * 0.85;
      if (pr.top >= comfortTop && pr.bottom <= comfortBottom) return; // already comfortably in view
      const delta = pr.top - (rv.top + rv.height * 0.3); // >0 scrolls down (content up)
      if (typeof r.scrollByDelta === "function") r.scrollByDelta(delta);
    } else {
      const cx = pr.left + pr.width / 2;
      const cy = pr.top + pr.height / 2;
      const inView = cx >= rv.left && cx <= rv.right && cy >= rv.top && cy <= rv.bottom;
      if (!inView) r.scrollToAnchor?.(range); // flip to the sentence's page
    }
  }

  /** Jump to a TOC target (an href; foliate resolves it). */
  goToHref(href: string): Promise<unknown> | undefined {
    return this.view?.goTo(href);
  }

  next(): void {
    this.view?.goLeft(); // RTL: physical-left advances
  }
  prev(): void {
    this.view?.goRight();
  }

  /** RAWY-184 (Part B): is there a chapter AFTER the one on screen? (for the end-of-chapter "next" control). */
  hasNextSection(): boolean {
    const cur = this.currentSectionIndex();
    const n = this.view?.book?.sections?.length ?? 0;
    return cur >= 0 && cur + 1 < n;
  }
  /** RAWY-184 (Part B): advance to the NEXT chapter (spine section) and await it, so the caller can then
   *  read it from the top. From the chapter end, foliate's forward step lands on the next section. */
  async goToNextChapter(): Promise<void> {
    const n = this.view?.book?.sections?.length ?? 0;
    const next = this.currentSectionIndex() + 1;
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
  pageByWheel(deltaY: number): void {
    if (!this.isFixedLayout || !deltaY) return;
    const now = performance.now();
    if (now - this.lastPageWheel < 280) return; // ~one page per wheel notch/gesture
    this.lastPageWheel = now;
    if (deltaY > 0) this.view?.next?.();
    else this.view?.prev?.();
  }

  /** RAWY-86: the number of pages in the open PDF (fixed-layout sections). */
  get pdfPageCount(): number {
    return this.view?.book?.sections?.length ?? 0;
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
      for await (const r of view.search({ query: q, draw: () => {} })) {
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
    // 4) DRAW the flash on the resolved range, DIRECTLY on the section's overlayer (the same overlayer.add
    // `view.addAnnotation` reaches, minus the throwing CFI re-resolution), so it ALWAYS appears. Only fall
    // back to `view.addAnnotation` when we have no range at all.
    try {
      const ct = nav ? v.renderer?.getContents?.().find((x) => x.index === nav.index && x.overlayer) : undefined;
      if (range && ct?.overlayer?.add) {
        const overlayer = ct.overlayer;
        overlayer.add?.(cfi, range, drawHighlight, { color: this.resolveColor("#E8C36A"), dark: this.theme?.dark ?? false });
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
