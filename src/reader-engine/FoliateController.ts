// FoliateController — the only place React touches foliate-js. Wraps a <foliate-view>
// custom element, embeds it in a container, and exposes a small, stable API
// (open / next / prev / goToLocator / onRelocate). RTL is automatic: foliate's
// PHYSICAL goLeft()/goRight() map to next/prev based on book.dir (proven RAWY-02).
//
// foliate-js is loaded as RAW ES modules from /foliate-js (public/), NOT through the
// bundler. We inject a runtime <script type="module"> tag (not an import()): Vite's
// import-analysis rejects importing /public files, but a script tag is served as-is and
// the browser resolves the engine's internal relative imports from /foliate-js/ (RAWY-02
// learning). Base CSS includes the deterministic section fix for the stray paginated
// scrollbar (RAWY-04), plus calm Arabic-first reading defaults (Amiri, generous leading).

export interface RelocateInfo {
  cfi: string | null;
  fraction: number;
}

// Injected into every book section via renderer.setStyles().
const READING_CSS = `
  @font-face {
    font-family: 'AmiriReader';
    src: url('/fonts/Amiri-Regular.ttf') format('truetype');
    font-weight: normal;
  }
  @font-face {
    font-family: 'AmiriReader';
    src: url('/fonts/Amiri-Bold.ttf') format('truetype');
    font-weight: bold;
  }
  /* deterministic section box → no stray vertical scrollbar in paginated mode (RAWY-04) */
  html, body { height: 100%; margin: 0; overflow: hidden; }
  img, svg, video, table { max-width: 100%; max-height: 100%; }
  /* Arabic-first reading defaults (hardcoded for now; controls come later) */
  body { font-family: 'AmiriReader', serif; }
  p, li, blockquote, div { line-height: 1.85; }
`;

function ensureFoliateDefined(): Promise<void> {
  if (customElements.get("foliate-view")) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const ready = () => customElements.whenDefined("foliate-view").then(() => resolve());
    const existing = document.querySelector<HTMLScriptElement>("script[data-foliate]");
    if (existing) {
      ready();
      return;
    }
    const s = document.createElement("script");
    s.type = "module";
    s.src = "/foliate-js/view.js"; // served raw from public/ (untouched by the bundler)
    s.dataset.foliate = "1";
    s.onload = ready;
    s.onerror = () => reject(new Error("Failed to load /foliate-js/view.js"));
    document.head.appendChild(s);
  });
}

export class FoliateController {
  private view: any | null = null;
  private relocateCb: ((info: RelocateInfo) => void) | null = null;

  /** Open `source` (an asset URL or path foliate can fetch) into `container`. */
  async open(source: string, container: HTMLElement, resumeCfi?: string | null): Promise<void> {
    await ensureFoliateDefined();

    const view = document.createElement("foliate-view") as any;
    container.replaceChildren(view);

    await view.open(source);
    view.renderer.setAttribute("flow", "paginated"); // columns + page turns

    view.addEventListener("relocate", (e: any) => {
      this.relocateCb?.({
        cfi: e.detail?.cfi ?? null,
        fraction: typeof e.detail?.fraction === "number" ? e.detail.fraction : 0,
      });
    });

    // Keyboard paging also when focus is inside the section iframe (RAWY-02 pattern).
    view.addEventListener("load", (e: any) => {
      const doc: Document | undefined = e.detail?.doc;
      doc?.addEventListener("keydown", (ev: KeyboardEvent) => {
        if (ev.key === "ArrowLeft") this.next();
        else if (ev.key === "ArrowRight") this.prev();
      });
    });

    view.renderer.setStyles?.(READING_CSS);
    this.view = view; // usable for paging before the first render settles

    if (resumeCfi) {
      await view.goTo(resumeCfi); // resume exactly where left off
    } else {
      await view.renderer.next(); // render the first page
    }
  }

  /** Reading-order next (RTL: physical-left). */
  next(): void {
    this.view?.goLeft();
  }

  /** Reading-order previous (RTL: physical-right). */
  prev(): void {
    this.view?.goRight();
  }

  /** Jump to a CFI locator. */
  goToLocator(cfi: string): Promise<unknown> | undefined {
    return this.view?.goTo(cfi);
  }

  onRelocate(cb: (info: RelocateInfo) => void): void {
    this.relocateCb = cb;
  }

  /** 'rtl' | 'ltr' | undefined — detected from the book. */
  get dir(): string | undefined {
    return this.view?.book?.dir;
  }

  destroy(): void {
    this.view?.close?.();
    this.view = null;
  }
}
