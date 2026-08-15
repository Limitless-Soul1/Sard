// Auto-scrolling while something is being dragged.
//
// Direct manipulation has one weakness that clicking a destination never had: you cannot drop on
// something you cannot see, and a drag holds the pointer captive, so the reader could not scroll
// to it without abandoning the operation and starting again. Carrying a book to a shelf further
// down the page was therefore impossible rather than merely awkward.
//
// The rule is the ordinary one: approach an edge and the container follows you, faster the closer
// you get. It runs only while a drag is live, only on the container that drag began in, and it
// tells the drag when it has scrolled so the insertion indicator can be recomputed — the pointer
// does not move during an auto-scroll, so nothing else would ever ask.

/** How deep into an edge the pointer must be before the container starts to follow. */
const BAND = 64;
/** The fastest it will go, in pixels per frame — about 900px/s at 60Hz. */
const MAX_STEP = 15;

/**
 * Pixels to scroll this frame: negative near the top edge, positive near the bottom, zero
 * between. The response is quadratic, so the first pixel into the band barely moves and the last
 * moves at full speed — which is what stops a drag from bolting the moment it nears an edge.
 */
export function edgeScrollStep(pointerY: number, top: number, bottom: number, band = BAND, max = MAX_STEP): number {
  if (bottom - top < band * 2) return 0; // too short to have two distinct edges; leave it alone
  const intoTop = band - (pointerY - top);
  if (intoTop > 0) {
    const depth = Math.min(1, intoTop / band);
    return -Math.max(1, Math.round(depth * depth * max));
  }
  const intoBottom = band - (bottom - pointerY);
  if (intoBottom > 0) {
    const depth = Math.min(1, intoBottom / band);
    return Math.max(1, Math.round(depth * depth * max));
  }
  return 0;
}

/** Can this element actually scroll vertically right now? */
export function isScrollable(el: Element | null): el is HTMLElement {
  if (!el || !(el instanceof HTMLElement)) return false;
  if (el.scrollHeight <= el.clientHeight + 1) return false;
  const overflow = getComputedStyle(el).overflowY;
  return overflow === "auto" || overflow === "scroll" || overflow === "overlay";
}

/**
 * The nearest ancestor that can scroll — which is what keeps an auto-scroll from moving a
 * container the reader is not pointing at.
 */
export function scrollableAncestor(el: Element | null): HTMLElement | null {
  let node: Element | null = el;
  while (node) {
    if (isScrollable(node)) return node;
    node = node.parentElement;
  }
  return null;
}

export interface EdgeScroller {
  /**
   * Name the container this drag lives in, from the ELEMENT that was pressed.
   *
   * Resolving it from coordinates instead looks equivalent and is not: a tile can be pressed
   * while its centre is below the fold, and `elementFromPoint` then answers null, so the drag had
   * no container and nothing scrolled. The element is always known; the point may not be.
   */
  setContainer: (el: Element | null) => void;
  /** Recompute the landing place after a scroll. Set by whichever drag currently owns it. */
  onScrolled: ((x: number, y: number) => void) | null;
  /** Call on every pointermove of a live drag. */
  update: (x: number, y: number) => void;
  /** Call on release, cancel, or Escape. */
  stop: () => void;
}

/**
 * The container a drag should scroll, resolved from where the drag STARTED.
 *
 * Asking `elementFromPoint` afresh every frame sounds equivalent and is not: near the bottom edge
 * of the library pane the topmost element is a child that establishes its own `overflow: hidden`
 * box, so the walk upward finds no scrollable ancestor and nothing moves. The container a drag
 * belongs to is decided once, by where it began, which is also what stops it reaching across and
 * scrolling something the reader is not working in.
 */
export function containerFor(x: number, y: number): HTMLElement | null {
  return scrollableAncestor(document.elementFromPoint(x, y));
}

/**
 * A scroller for one drag.
 *
 * `onScrolled` is invoked after any frame that actually moved the container, with the pointer
 * position unchanged — the drag uses it to recompute where the item would land, because no
 * pointermove will arrive to prompt it while the reader holds still at an edge.
 */
export function createEdgeScroller(onScrolled?: (x: number, y: number) => void): EdgeScroller {
  let raf = 0;
  let live = false;
  let px = 0;
  let py = 0;
  let box: HTMLElement | null = null;

  const frame = () => {
    if (!live) return;
    // The container this drag belongs to, remembered from the first frame that could name one.
    // Re-asking every frame is what failed: at an edge the topmost element can sit inside an
    // `overflow: hidden` box, and the walk upward then finds nothing to scroll.
    if (!box) box = containerFor(px, py);
    if (box) {
      const r = box.getBoundingClientRect();
      const step = edgeScrollStep(py, r.top, r.bottom);
      if (step) {
        const before = box.scrollTop;
        box.scrollTop = before + step;
        if (box.scrollTop !== before) api.onScrolled?.(px, py);
      }
    }
    raf = requestAnimationFrame(frame);
  };

  const api: EdgeScroller = {
    onScrolled: onScrolled ?? null,
    setContainer(el) {
      box = scrollableAncestor(el);
    },
    update(x, y) {
      px = x;
      py = y;
      if (live) return;
      live = true;
      raf = requestAnimationFrame(frame);
    },
    stop() {
      live = false;
      box = null;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    },
  };
  return api;
}
