/**
 * WHERE SURFACES THAT FLOAT OVER THE LIBRARY ARE DRAWN.
 *
 * A menu, a sheet, a popover: each one has to be above every other layer, and each one has to look
 * like Sard. Those two requirements pulled in opposite directions and the second one lost.
 *
 * Drawn inside the tile it belongs to, a book's menu was ranked only among that tile's siblings —
 * so in Spines, where the tiles are twenty-two pixels apart and sit against the sidebar, the menu
 * opened underneath the sidebar and the press meant for «تعديل التفاصيل» landed on a shelf row.
 * Moving it to `document.body` fixed the stacking and broke the appearance instead: every design
 * token is defined on `.libd-root`, so outside that element `--chr`, `--brd`, `--txt` and `--hov`
 * all resolved to nothing. Measured — a transparent panel with no border and no shadow, items
 * painted the browser's default grey, and a hover rule that was invalid and therefore cleared the
 * background, which is the "it goes strangely transparent when I point at it" the reader saw.
 *
 * The host is the answer to both at once: one element, mounted INSIDE the shell so it inherits the
 * tokens, and painted above everything so nothing can cover it. A surface asks for it and portals
 * into it, and stops caring where in the tree the thing that opened it happens to live.
 *
 * `document.body` remains the fallback for the same reason a fallback usually exists — a surface
 * rendered before the shell, or in a test, should still appear rather than throw.
 */

export const OVERLAY_HOST_CLASS = "libd-overlay-host";

/** The element floating surfaces should be drawn into. */
export function overlayHost(): HTMLElement {
  if (typeof document === "undefined") {
    throw new Error("no document");
  }
  return document.querySelector<HTMLElement>("." + OVERLAY_HOST_CLASS) ?? document.body;
}
