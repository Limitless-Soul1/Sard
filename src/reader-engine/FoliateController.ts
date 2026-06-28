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

import { buildReadingCss, type ReadingStyle } from "./injectedCss";

export interface RelocateInfo {
  cfi: string | null;
  fraction: number;
}

interface OpenOptions {
  resumeCfi?: string | null;
  style: ReadingStyle;
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
  private relocateCb: ((info: RelocateInfo) => void) | null = null;

  /** Tear down the current view + listeners. Safe to call repeatedly. */
  dispose(): void {
    const v = this.view;
    this.view = null;
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

    view.addEventListener("relocate", (e: any) => {
      this.relocateCb?.({
        cfi: e.detail?.cfi ?? null,
        fraction: typeof e.detail?.fraction === "number" ? e.detail.fraction : 0,
      });
    });
    view.addEventListener("load", (e: any) => {
      const doc: Document | undefined = e.detail?.doc;
      if (!doc) return;
      wrapTashkil(doc); // enable the diacritics toggle for this section
      doc.addEventListener("keydown", (ev: KeyboardEvent) => {
        if (ev.key === "ArrowLeft") this.next();
        else if (ev.key === "ArrowRight") this.prev();
      });
    });

    this.applyStyle(opts.style);

    if (opts.resumeCfi) await view.goTo(opts.resumeCfi);
    else await view.renderer.next();
  }

  /** Re-inject the full stylesheet for a ReadingStyle (the single visual funnel). */
  applyStyle(style: ReadingStyle): void {
    this.style = style;
    this.view?.renderer?.setStyles?.(buildReadingCss(style));
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
    return this.view?.book?.dir;
  }
}
