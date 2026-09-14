// IS THIS DRAG COMING FROM OUTSIDE? — the one rule, kept where a test can reach it.
//
// The Library's «Drop to add books» overlay is driven by the webview's drag-and-drop events, which
// are OS-level: they fire for a file dragged in from Explorer, and they fire just the same for a
// drag that began INSIDE the page and went through the OS on its way round. A cover image is a
// native drag source unless told otherwise, so pressing a book and drifting a few pixels while
// holding it started exactly such a drag — and the overlay answered it as though a book were
// arriving from outside, with no count, because there were no files. Measured on the real library.
//
// What tells the two apart is the payload: a file drag ENTERS with the paths it carries. A drag with
// no paths is not an import, whatever else it is. And `over` says nothing about origin at all, so it
// can only keep an overlay that `enter` already earned — it never conjures one.

/** The overlay's state: how many books are arriving, or nothing. */
export type ExternalDrag = { count: number } | null;

/** The shape of the webview's drag-and-drop payload that this rule reads. */
export type DragDropPayload =
  | { type: "enter"; paths: string[] }
  | { type: "over" }
  | { type: "leave" }
  | { type: "drop"; paths: string[] };

/** Fold one drag-and-drop event into the overlay's state. Pure, so the rule can be tested alone. */
export function externalDragState(prev: ExternalDrag, e: DragDropPayload): ExternalDrag {
  switch (e.type) {
    case "enter":
      // Files came in with it: an import is being offered. Nothing came in: not ours to answer.
      return e.paths.length > 0 ? { count: e.paths.length } : null;
    case "over":
      // Position only. Keeps what `enter` established and never invents an overlay of its own.
      return prev;
    case "leave":
    case "drop":
      return null;
  }
}
