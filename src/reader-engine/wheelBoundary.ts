// WHAT A WHEEL MEANS AT THE EDGE OF A CHAPTER.
//
// In scrolled flow there are no pages to turn, so the wheel does two jobs: it scrolls within the
// chapter, and — at the chapter's edge, on a deliberate second push — it crosses into the next or
// previous one. Deciding between those is the whole of this file, and it is a pure function so that
// the decision can be tested against geometry that is otherwise only reachable by rendering a real
// book at a real window size.
//
// ── WHY A GESTURE HAS AN EDGE ──────────────────────────────────────────────────────────────────
//
// Reaching the end of a chapter in one continuous scroll must STOP there rather than sail on into
// the next: a reader who flicks hard to finish a page should not find themselves two chapters along.
// So a gesture remembers which edge it began at, acts at most once, and a new gesture only begins
// after a pause. That is what `edge` and `acted` are for, and none of it changes here.
//
// ── THE SECTION THAT IS AT BOTH EDGES AT ONCE ──────────────────────────────────────────────────
//
// A chapter shorter than the window — a dedication, a part title, an epigraph, a one-line colophon —
// has no travel inside it at all. Its top IS its bottom: there is nowhere to scroll, so the viewport
// satisfies "at the top" and "at the bottom" simultaneously, and the edge a gesture begins at cannot
// be read off the position.
//
// Measured in the running reader on a book of such sections (window 1280x860): a one-line section
// reported viewSize 228 against size 860 — a NEGATIVE travel of 632px — with start 0. Naming the
// edge by position alone answered "bottom" for every one of them, because that is simply the arm the
// test reached first. Scrolling down therefore crossed to the next chapter, and scrolling up asked
// for an edge the gesture could never be at, so it was refused: three deliberate upward gestures left
// the reader exactly where they started, on every short section, in Arabic and in English alike. The
// engine was willing the whole time — `prev()` called directly moved back at once — so nothing was
// wrong with navigation, the controls, or the content. Only this decision.
//
// When there is no travel, the gesture's own DIRECTION names the edge, which is the only information
// present: pushing up from a section that cannot scroll can only mean "take me back", and pushing
// down can only mean "take me on". A section that CAN scroll is untouched by this and still names its
// edge by position, so ordinary chapters behave exactly as they always have.

/** How far apart two wheel events must be to count as separate gestures. */
export const BOUNDARY_PAUSE_MS = 140;
/** How close to an edge still counts as being at it, in pixels. */
export const BOUNDARY_EDGE_PX = 4;

/** What the caller should do with this wheel event. */
export type WheelAction = "next" | "prev" | "hold" | "scroll";

/** The scroll geometry of the section on screen, as the renderer reports it. */
export interface WheelGeometry {
  /** The section's full extent. */
  viewSize: number;
  /** The viewport's extent. */
  size: number;
  /** How far into the section the viewport is. */
  start: number;
}

/** What the current wheel gesture has established so far. */
export interface WheelGesture {
  /** When this gesture was last seen. */
  wheelTs: number;
  /** The edge it began at, or null when it began mid-chapter. */
  edge: "top" | "bottom" | null;
  /** Whether it has already crossed a boundary — a gesture crosses at most one. */
  acted: boolean;
}

export const IDLE_GESTURE: WheelGesture = { wheelTs: 0, edge: null, acted: false };

/**
 * Decide what one wheel event means, and hand back the gesture state to keep.
 *
 * `now` is passed in rather than read here so a test can place two events a known distance apart
 * without waiting, and so the two call sites (the content frame's own wheel and the one forwarded
 * from the margins) share one clock exactly as they share one gesture.
 */
export function wheelBoundary(
  deltaY: number,
  geom: WheelGeometry,
  state: WheelGesture,
  now: number,
): { action: WheelAction; state: WheelGesture } {
  const { viewSize, size, start } = geom;
  // Renderer not laid out yet (getters 0/NaN) → never trap the wheel, or the page would freeze.
  // Deliberately BEFORE the gesture clock is touched: a wheel arriving mid-layout must not start or
  // extend a gesture, or the first real event afterwards would not read as fresh.
  if (!(viewSize > 0) || !(size > 0)) return { action: "scroll", state };

  const fresh = now - state.wheelTs > BOUNDARY_PAUSE_MS;
  const next: WheelGesture = { wheelTs: now, edge: state.edge, acted: state.acted };

  const scrollable = viewSize - size > BOUNDARY_EDGE_PX;
  const atBottom = scrollable ? viewSize - (start + size) <= BOUNDARY_EDGE_PX : true;
  const atTop = start <= BOUNDARY_EDGE_PX;
  const down = deltaY > 0;

  if (fresh) {
    // A section with no travel is at both edges at once, so position cannot name the edge and the
    // direction of the push does. A section that can scroll answers from its position, as before.
    next.edge = !scrollable ? (down ? "bottom" : "top") : atBottom ? "bottom" : atTop ? "top" : null;
    next.acted = false;
  }

  if (down && atBottom) {
    if (next.edge === "bottom" && !next.acted) {
      next.acted = true;
      return { action: "next", state: next };
    }
    return { action: "hold", state: next };
  }
  if (!down && atTop) {
    if (next.edge === "top" && !next.acted) {
      next.acted = true;
      return { action: "prev", state: next };
    }
    return { action: "hold", state: next };
  }
  return { action: "scroll", state: next };
}
