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

import { buildReadingCss, type BookThemeFlags, type ReadingStyle } from "./injectedCss";
import type { Theme } from "../theme/tokens";

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
  style: ReadingStyle;
  theme?: Theme;
  flags?: BookThemeFlags;
  /** Corrected reading direction (a metadata override) — wins over the EPUB's own. */
  dir?: string | null;
  /** Reading flow (RAWY-25): "scrolled" (default) or "paged". */
  flow?: "scrolled" | "paged";
}

// Arabic combining marks (tashkīl). We wrap runs of them in spans so the diacritics
// toggle can dim/hide them purely via injected CSS (no character removal → text offsets
// stay stable, keeping CFIs valid).
const MARKS = "\\u064B-\\u065F\\u0670\\u06D6-\\u06DC\\u06DF-\\u06E4\\u06E7\\u06E8\\u06EA-\\u06ED";
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

// Chapter-boundary scroll gesture (RAWY-25): a wheel gap longer than this starts a NEW
// gesture. So a single burst that reaches the chapter end STOPS there; only a fresh gesture
// (after this pause) advances to the next chapter.
const BOUNDARY_PAUSE_MS = 220;
const BOUNDARY_EDGE_PX = 4;

export class FoliateController {
  private view: any | null = null;
  private style: ReadingStyle | null = null;
  private theme: Theme | undefined = undefined;
  private flags: BookThemeFlags = { overrideBookColor: false, hideChapterTitles: false };
  private forcedDir: string | undefined = undefined; // corrected direction (RAWY-19)
  private relocateCb: ((info: RelocateInfo) => void) | null = null;
  // Highlights (RAWY-20): cfi → semantic colour slot; re-applied per section render.
  private annotations = new Map<string, string>();
  private selectionCb: ((sel: SelectionInfo | null) => void) | null = null;
  private showCb: ((hit: AnnotationHit) => void) | null = null;
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
    this.scrolledMode = opts.flow !== "paged";
    view.renderer.setAttribute("flow", this.scrolledMode ? "scrolled" : "paginated");

    // RAWY-19: a corrected direction (override) wins over the EPUB's page-progression so a
    // mistagged book (e.g. an Arabic book tagged ltr) reads + pages RTL once fixed.
    this.forcedDir = opts.dir ?? undefined;
    if (this.forcedDir && view.book) view.book.dir = this.forcedDir;

    view.addEventListener("relocate", (e: any) => {
      this.relocateCb?.({
        cfi: e.detail?.cfi ?? null,
        fraction: typeof e.detail?.fraction === "number" ? e.detail.fraction : 0,
        chapterLabel: e.detail?.tocItem?.label ?? null,
        chapterHref: e.detail?.tocItem?.href ?? null,
      });
    });
    view.addEventListener("load", (e: any) => {
      const doc: Document | undefined = e.detail?.doc;
      const index: number = e.detail?.index ?? 0;
      if (!doc) return;
      wrapTashkil(doc); // enable the diacritics toggle for this section
      doc.addEventListener("keydown", (ev: KeyboardEvent) => {
        if (ev.key === "ArrowLeft") this.next();
        else if (ev.key === "ArrowRight") this.prev();
      });
      // Scrolled mode: the chapter-boundary "new gesture to advance" handler (RAWY-25).
      if (this.scrolledMode)
        doc.addEventListener("wheel", (ev: WheelEvent) => this.onBoundaryWheel(ev), { passive: false });
      // Selection → in-context toolbar (RAWY-20).
      doc.addEventListener("pointerdown", () => this.selectionCb?.(null));
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
    this.reinject();

    if (opts.resumeCfi) await view.goTo(opts.resumeCfi);
    else if (this.scrolledMode) await view.goToFraction(0); // start at the top of section 0
    else await view.renderer.next();
  }

  /** Re-inject the full stylesheet (typography + theme) — the single visual funnel. */
  private reinject(): void {
    if (this.style)
      this.view?.renderer?.setStyles?.(buildReadingCss(this.style, this.theme, this.flags, this.dir));
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
  private onBoundaryWheel(e: WheelEvent): void {
    const r = this.view?.renderer;
    if (!r || !this.scrolledMode) return;
    const viewSize = r.viewSize as number;
    const size = r.size as number;
    const start = r.start as number;
    // Renderer not laid out yet (getters 0/NaN) → never trap the wheel, or we'd freeze the page.
    if (!(viewSize > 0) || !(size > 0)) return;
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
    const down = e.deltaY > 0;
    if (down && atBottom) {
      e.preventDefault(); // hold the boundary — don't chain to the next chapter mid-gesture
      if (this.gestureEdge === "bottom" && !this.gestureActed) {
        this.gestureActed = true;
        r.next?.();
      }
    } else if (!down && atTop) {
      e.preventDefault();
      if (this.gestureEdge === "top" && !this.gestureActed) {
        this.gestureActed = true;
        r.prev?.();
      }
    }
  }

  /** Flattened TOC (chapters panel, RAWY-21). Empty if the book exposes none. */
  getToc(): TocEntry[] {
    const out: TocEntry[] = [];
    const walk = (items: any[] | undefined, level: number) => {
      if (!Array.isArray(items)) return;
      for (const it of items) {
        out.push({ label: String(it?.label ?? "").trim(), href: it?.href ?? null, level });
        if (it?.subitems) walk(it.subitems, level + 1);
      }
    };
    walk(this.view?.book?.toc, 0);
    return out;
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
}
