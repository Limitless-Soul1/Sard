// THE DISMISSAL STACK.
//
// A transient surface is anything that opens over the library and must go away again: a book's ⋯
// menu, the sort menu, the format filter, a case's ⋯ menu. Before this, each one owned its own
// `useState` and its own full-screen overlay, and the consequences were all the ones you would
// predict from that:
//
//   - two book menus could be open at once, because no one owned "the" menu;
//   - clicking outside a book menu dismissed nothing, because a book menu had no overlay at all;
//   - Escape reached Vista's navigation handler while a menu was open, so it surfaced a level
//     instead of closing the menu;
//   - and switching from the sort menu to the filter menu took two clicks, because the first was
//     swallowed by the sort menu's own overlay rather than reaching the filter button.
//
// One owner fixes all four. A surface registers while it is open and unregisters when it closes;
// opening one closes whatever was open before it; a pointer press outside every registered surface
// closes them; and Escape is intercepted IN THE CAPTURE PHASE so it is spent on the topmost surface
// before any other listener — including the one that walks Vista up a level — ever sees it.
//
// WHAT "OUTSIDE" MEANS, and this is the part that had to be corrected. "Not inside the element" is
// not the same as "outside the surface": a press one pixel past the border box counted exactly like
// a press across the room, so reaching for a control near the edge and missing by three pixels shut
// the surface. Two amendments, both here rather than in each caller:
//
//   · a near miss is a miss. A press within `guardPx` of the surface is not an outside press.
//   · a surface that owns its own backdrop decides for itself. A full sheet with a scrim already
//     has a rule for the gesture — it requires a press that BEGAN outside and ends outside, which
//     this listener cannot know, seeing only the press. It registers with `outsidePress: false`,
//     which keeps everything else it joined the stack for: Escape, and closing whatever was open
//     beneath it.
//
// Deliberately not a React context: `BookTile` is drawn by five views through three different
// parents, and threading a provider through all of them to say "only one of you at a time" is more
// moving parts than the rule deserves.
import { isOnBackdrop, NEAR_MISS_PX } from "../../../components/useDialog";

interface Entry {
  close: () => void;
  /** The surface's own element, so a press inside it is not a press outside it. */
  el: () => Element | null;
  /** How far past that element still belongs to it. */
  guardPx: number;
  /** Whether an outside press dismisses this surface at all. */
  outsidePress: boolean;
}

let stack: Entry[] = [];
let bound = false;

function closeAll() {
  const going = stack;
  stack = [];
  for (const e of going) e.close();
}

/**
 * Does a press at this point dismiss a surface with these properties?
 *
 * Pure, and exported, because it is the rule that was wrong: "not inside the element" is not the
 * same as "outside the surface", and a listener has no way to say so in a test.
 */
export function pressDismisses(
  surface: {
    /** Did the press land on the surface's own tree? */
    inside: boolean;
    /** Where the surface is, or `null` before it has been laid out. */
    rect: { left: number; right: number; top: number; bottom: number } | null;
    guardPx: number;
    outsidePress: boolean;
  },
  x: number,
  y: number,
): boolean {
  if (surface.inside) return false;          // inside a surface: not an outside press
  if (!surface.outsidePress) return false;   // the surface answers for its own backdrop
  return isOnBackdrop(x, y, surface.rect, surface.guardPx);
}

function onPointerDown(e: PointerEvent) {
  if (!stack.length) return;
  const target = e.target as Node | null;
  for (const entry of stack) {
    const el = entry.el();
    const dismisses = pressDismisses(
      {
        inside: !!(el && target && el.contains(target)),
        rect: el ? el.getBoundingClientRect() : null,
        guardPx: entry.guardPx,
        outsidePress: entry.outsidePress,
      },
      e.clientX,
      e.clientY,
    );
    // One surface at a time, so the first that keeps the press keeps it for the whole stack.
    if (!dismisses) return;
  }
  closeAll();
}

function onKeyDown(e: KeyboardEvent) {
  if (e.key !== "Escape" || !stack.length) return;
  // The topmost surface spends the key. `stopPropagation` in the CAPTURE phase is what keeps it
  // from also reaching the window-level handlers underneath — Vista's "go up one level" among them.
  const top = stack[stack.length - 1];
  stack = stack.slice(0, -1);
  top.close();
  e.stopPropagation();
  e.preventDefault();
}

function bind() {
  if (bound || typeof window === "undefined") return;
  bound = true;
  window.addEventListener("keydown", onKeyDown, true);
  document.addEventListener("pointerdown", onPointerDown, true);
}

/**
 * Open one transient surface, closing every other.
 *
 * `guardPx` is the near-miss margin around the surface; `outsidePress: false` says the surface
 * dismisses itself by its own backdrop rule and this listener must not act on the press.
 *
 * Returns the disposer the caller must run when the surface closes for any other reason — chosen an
 * action, unmounted, navigated away. Calling it twice is harmless.
 */
export function openTransient(
  close: () => void,
  el: () => Element | null,
  opts: { guardPx?: number; outsidePress?: boolean } = {},
): () => void {
  bind();
  closeAll();
  const entry: Entry = {
    close,
    el,
    guardPx: opts.guardPx ?? NEAR_MISS_PX,
    outsidePress: opts.outsidePress ?? true,
  };
  stack = [entry];
  return () => {
    stack = stack.filter((x) => x !== entry);
  };
}

// THE TEST SEAM, and nothing else is exported.
//
// The stack has no other observable surface — it is a keydown listener and a pointerdown listener —
// so without these two the contract it exists to enforce could not be asserted at all. Production
// uses `openTransient` and nothing more.
export const dismissTransients = () => closeAll();
export const transientDepth = () => stack.length;
