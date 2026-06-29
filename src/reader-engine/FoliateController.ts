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
  rose: "#E0A6A0",
  sky: "#A8C4D6",
  green: "#B6C9A6",
  purple: "#C7B6D6",
};

// Our own highlight draw function (so we never import from /public): an SVG <g> of
// translucent rects over the selection — the "inked" highlighter look. Elements are
// created in the parent document and adopted when foliate's overlayer appends them.
function drawHighlight(rects: Iterable<DOMRect>, options: { color?: string } = {}): SVGGElement {
  const NS = "http://www.w3.org/2000/svg";
  const g = document.createElementNS(NS, "g");
  g.setAttribute("fill", options.color ?? "#E8C36A");
  g.style.opacity = "var(--overlayer-highlight-opacity, .35)";
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

    view.renderer.setAttribute("flow", "paginated");

    // RAWY-19: a corrected direction (override) wins over the EPUB's page-progression so a
    // mistagged book (e.g. an Arabic book tagged ltr) reads + pages RTL once fixed.
    this.forcedDir = opts.dir ?? undefined;
    if (this.forcedDir && view.book) view.book.dir = this.forcedDir;

    view.addEventListener("relocate", (e: any) => {
      this.relocateCb?.({
        cfi: e.detail?.cfi ?? null,
        fraction: typeof e.detail?.fraction === "number" ? e.detail.fraction : 0,
        chapterLabel: e.detail?.tocItem?.label ?? null,
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
      draw(drawHighlight, { color: this.resolveColor(annotation.color) });
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
    else await view.renderer.next();
  }

  /** Re-inject the full stylesheet (typography + theme) — the single visual funnel. */
  private reinject(): void {
    if (this.style)
      this.view?.renderer?.setStyles?.(buildReadingCss(this.style, this.theme, this.flags, this.forcedDir));
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
  private resolveColor(slot: string): string {
    const set = this.theme?.colors.highlight as Record<string, string> | undefined;
    return set?.[slot] ?? HL_FALLBACK[slot] ?? slot;
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

  next(): void {
    this.view?.goLeft(); // RTL: physical-left advances
  }
  prev(): void {
    this.view?.goRight();
  }
  goToLocator(cfi: string): Promise<unknown> | undefined {
    return this.view?.goTo(cfi);
  }
  onRelocate(cb: (info: RelocateInfo) => void): void {
    this.relocateCb = cb;
  }
  get dir(): string | undefined {
    return this.forcedDir ?? this.view?.book?.dir;
  }
}
