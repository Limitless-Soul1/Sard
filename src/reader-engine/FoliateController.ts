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

import { buildReadingCss, type BookThemeFlags, type ReadingStyle, type RevealLabels } from "./injectedCss";
import type { Theme } from "../theme/tokens";
import { extractChapterNumber, toWesternDigits } from "../lib/format";

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

function isChapterHeadingCandidate(rawText: string, realNum: number): boolean {
  const text = toWesternDigits(rawText).trim();
  if (!text || text.length > IN_BODY_HEADING_MAX_LEN) return false;
  const m = text.match(/\d+/);
  if (!m || m.index == null || m.index > MAX_HEADING_NUMBER_PREFIX) return false;
  return m[0] === String(realNum);
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
  if (realNum == null) return; // no number to ground the match against — don't guess
  const blocks: Element[] = [];
  collectLeadingBlocks(body, MAX_LEADING_HEADING_ELEMENTS, blocks);
  for (const el of blocks) {
    if (!isChapterHeadingCandidate(el.textContent ?? "", realNum)) break; // real prose starts here — stop
    if (HEADING_TAGS.has(el.tagName.toUpperCase())) continue; // a real heading — the title toggle owns it
    el.classList.add("sard-chapter-heading");
    // RAWY-70: put a placeholder immediately before the line so the reveal handler can find the
    // line as `ph.nextElementSibling`. It's inert (CSS `display:none`) until hideFirstLine is on.
    el.insertAdjacentElement("beforebegin", buildTitlePlaceholder(doc));
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
  private selectionCb: ((sel: SelectionInfo | null) => void) | null = null;
  private showCb: ((hit: AnnotationHit) => void) | null = null;
  // RAWY-72: forward pointer activity happening INSIDE the content iframe (which never reaches a
  // parent-window listener) so the chrome-on-intent hook can wake the auto-hiding bar. Coords are
  // translated to parent-viewport space so the hook's jitter dedup shares one coordinate system.
  private activityCb: ((x: number, y: number, isTap: boolean) => void) | null = null;
  // RAWY-73: scroll intent (scrolled mode) — accumulate wheel delta and fire a debounced direction
  // so a small jitter doesn't toggle the bar. down = scroll down (hide), up = scroll up (show).
  private scrollIntentCb: ((down: boolean) => void) | null = null;
  private scrollAccum = 0;
  private scrollIntentTs = 0; // RAWY-75: last wheel time — a long gap resets the accumulator
  // Scrolled mode + chapter-boundary gesture state (RAWY-25).
  private scrolledMode = false;
  private wheelTs = 0;
  private gestureEdge: "top" | "bottom" | null = null;
  private gestureActed = false;

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
      this.relocateCb?.({
        cfi: e.detail?.cfi ?? null,
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
          else if (ev.key === "ArrowRight" || ev.key === "ArrowDown" || ev.key === "PageDown" || ev.key === " ") this.view?.next?.();
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
      wrapTashkil(doc); // enable the diacritics toggle for this section
      markInBodyHeading(doc, sectionTocLabel(view, index)); // RAWY-67: hide-titles catches this too
      // RAWY-70: the two-step reveal for the hide-first-line placeholder. Handled from the parent
      // frame (the content iframe runs no scripts, RAWY-64) via cross-frame DOM access, like the
      // handlers below. Per-instance + reset-on-navigation is automatic: each section is a fresh
      // doc with a fresh idle placeholder.
      doc.addEventListener("click", (ev: Event) => this.onRevealClick(ev));
      doc.addEventListener("keydown", (ev: KeyboardEvent) => {
        if (ev.key === "ArrowLeft") this.next();
        else if (ev.key === "ArrowRight") this.prev();
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
      this.showCb?.({ cfi: value, rect: this.rangeRectInParent(index, range) });
    });
    view.addEventListener("create-overlay", () => {
      for (const [cfi, color] of this.annotations) view.addAnnotation({ value: cfi, color });
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

  /** Re-inject the full stylesheet (typography + theme) — the single visual funnel. */
  private reinject(): void {
    if (this.style)
      this.view?.renderer?.setStyles?.(
        buildReadingCss(this.style, this.theme, this.flags, this.dir, this.revealLabels),
      );
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

  /** Update typography (size/font/spacing/margins/align/diacritics). */
  applyStyle(style: ReadingStyle): void {
    this.style = style;
    this.reinject();
  }

  /** Update theme colours + book flags (override-colour, hide-titles). */
  applyTheme(theme: Theme, flags: BookThemeFlags): void {
    this.theme = theme;
    this.flags = flags;
    this.reinject();
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
  async pdfFind(query: string, fromIndex: number): Promise<number | null> {
    const book: any = this.view?.book;
    if (!book?.getPageText || !book?.sections?.length) return null;
    const q = normalizeForSearch(query);
    if (!q) return null;
    const n = book.sections.length;
    const cap = Math.min(n, 400); // scan at most this many pages for a match
    for (let k = 1; k <= cap; k++) {
      const i = (fromIndex + k) % n;
      let text = "";
      try {
        text = (await book.getPageText(i)) ?? "";
      } catch {
        continue;
      }
      if (normalizeForSearch(text).includes(q)) {
        await this.view?.goToFraction?.((i + 0.5) / n); // section midpoint → getSection() lands on page i
        return i;
      }
    }
    return null;
  }

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
  /** RAWY-85: the page-1 cover as PNG bytes (PDF adapter's getCover), for library enrichment. */
  async getCoverBytes(): Promise<number[] | null> {
    try {
      const blob: Blob | undefined = await this.view?.book?.getCover?.();
      if (!blob) return null;
      return Array.from(new Uint8Array(await blob.arrayBuffer()));
    } catch {
      return null;
    }
  }
}
