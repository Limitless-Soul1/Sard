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

/**
 * The element floating surfaces should be drawn into — the NEAREST one that offers itself.
 *
 * WHY NEAREST, AND NOT SIMPLY THE FIRST. The host solves stacking by being painted above its own
 * shell, and it solves appearance by living inside the element where that shell's tokens are
 * defined. A modal opened OVER the Library has its own tokens and its own shell, so both halves of
 * that argument point at its own host rather than the Library's: the photo composer defines
 * `--pc-chrome`, `--pc-line`, `--pc-surface` on `.pcx-modal`, and a surface portalled into the
 * Library's host would land outside them and come out unstyled — the exact failure this file was
 * written about, one layer up.
 *
 * So a caller passes the element it is opening FROM, and gets the host of the closest shell that
 * declares one. With no element, or none found, the search falls back to the first host in the
 * document and then to `document.body`, which is what every existing caller already relied on.
 */
export function overlayHost(from?: Element | null): HTMLElement {
  if (typeof document === "undefined") {
    throw new Error("no document");
  }
  for (let e: Element | null = from ?? null; e; e = e.parentElement) {
    const own = e.querySelector<HTMLElement>(":scope > ." + OVERLAY_HOST_CLASS);
    if (own) return own;
  }
  return document.querySelector<HTMLElement>("." + OVERLAY_HOST_CLASS) ?? document.body;
}

/**
 * WHERE AN ANCHORED PANEL GOES — centred under its trigger, and never outside the window.
 *
 * Kept as arithmetic, apart from the element that uses it, because placement is the half of this
 * problem a portal does NOT solve. Moving a panel into the overlay host frees it from its parent's
 * stacking context and from every `overflow: hidden` on the way up; it does nothing about a panel
 * whose trigger sits near an edge, which then hangs off the window instead of off a column. Both
 * failures look identical to a reader and only one of them is about layers.
 *
 * The rule is the one `InkCustom` arrived at by measurement: prefer the natural side, slide back
 * inside when that would overflow, and flip above the trigger only when there is genuinely no room
 * below AND there is room above. A panel taller than the window is pinned to the top edge rather
 * than centred out of reach at both ends.
 */
export function placeAnchored(
  anchor: { left: number; top: number; width: number; height: number },
  panel: { width: number; height: number },
  view: { width: number; height: number },
  opts: { gap?: number; edge?: number } = {},
): { left: number; top: number; flipped: boolean } {
  const gap = opts.gap ?? 9;
  const edge = opts.edge ?? 8;
  let left = anchor.left + anchor.width / 2 - panel.width / 2;
  let top = anchor.top + anchor.height + gap;
  const roomBelow = view.height - edge - top >= panel.height;
  const above = anchor.top - gap - panel.height;
  const flipped = !roomBelow && above >= edge;
  if (flipped) top = above;
  top = Math.max(edge, Math.min(top, view.height - panel.height - edge));
  left = Math.max(edge, Math.min(left, view.width - panel.width - edge));
  return { left, top, flipped };
}
