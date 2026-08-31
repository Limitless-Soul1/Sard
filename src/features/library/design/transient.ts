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
// Deliberately not a React context: `BookTile` is drawn by five views through three different
// parents, and threading a provider through all of them to say "only one of you at a time" is more
// moving parts than the rule deserves.

interface Entry {
  close: () => void;
  /** The surface's own element, so a press inside it is not a press outside it. */
  el: () => Element | null;
}

let stack: Entry[] = [];
let bound = false;

function closeAll() {
  const going = stack;
  stack = [];
  for (const e of going) e.close();
}

function onPointerDown(e: PointerEvent) {
  if (!stack.length) return;
  const target = e.target as Node | null;
  for (const entry of stack) {
    const el = entry.el();
    if (el && target && el.contains(target)) return; // inside a surface: not an outside press
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
 * Returns the disposer the caller must run when the surface closes for any other reason — chosen an
 * action, unmounted, navigated away. Calling it twice is harmless.
 */
export function openTransient(close: () => void, el: () => Element | null): () => void {
  bind();
  closeAll();
  const entry: Entry = { close, el };
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
