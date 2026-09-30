// WHEN THE WINDOW'S OWN FRAME IS ON SCREEN — the one decision, kept apart from the component so it
// can be pinned by a test that needs no DOM.
//
// The frame exists only on a window the OS does not decorate, and withdraws entirely in native
// fullscreen: not hidden, not transparent — not rendered, and the surfaces below stop reserving its
// height (`data-chrome` leaves the root). Maximized is an ordinary window state and keeps the frame.

export interface WindowFrameState {
  /** `null` until the window has answered `isDecorated()`. */
  decorated: boolean | null;
  fullscreen: boolean;
}

/** True when the frame is rendered and the surfaces below start under it. */
export function frameShown(s: WindowFrameState): boolean {
  return s.decorated === false && !s.fullscreen;
}
