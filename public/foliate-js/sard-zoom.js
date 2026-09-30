// SARD'S OWN FILE (not vendored foliate-js code) — the ONE zoom range both fixed-layout renderers use.
// Listed in VENDOR.txt, LOCAL MODIFICATIONS 14, because a re-vendor of fixed-layout.js must keep
// importing it.
//
// WHY A RANGE THAT DEPENDS ON THE WINDOW. The range used to be 0.5x–6x of the PDF's own page size,
// in the interface only. Neither end meant anything a reader can see:
//
//   * THE FLOOR. How small 0.5x looks depends on the window, not on the PDF. MEASURED on an A4 page:
//     "whole page" is 0.775x in an 1100x720 window, so 0.5x was 64% of it; on a 2560x1440 screen
//     "whole page" is about 1.58x, so the same 0.5x was 32% — three thumbnails per screen. So the
//     floor is stated relative to "whole page": half of it, i.e. two pages per screen in Scroll mode,
//     the smallest size at which a page is still a page and not an icon of one.
//
//   * THE CEILING. pdf.js paints each page as ONE bitmap, `floor(size * zoom * devicePixelRatio)`
//     device pixels on a side, with no limit of its own here. MEASURED on an A4 text page: 18 Mpx at
//     6x (263 ms), 32 Mpx at 8x (428 ms) — four bytes a pixel, and Scroll mode keeps up to three
//     pages mounted, so 8x is ~380 MB of bitmap. The ceiling is therefore a BITMAP BUDGET, the
//     2^24-pixel canvas limit pdf.js itself used by default for years (`maxCanvasPixels`). It scales
//     with the page: a small page may be magnified further than a poster, and a high-density screen
//     reaches the budget at a lower zoom, because that is where the cost actually is.
//
// The fit modes are NEVER clamped — "fit width" and "whole page" are what they say whatever the
// numbers, and the range is widened to contain them if it ever has to be.

/** The smallest page, as a fraction of "whole page". */
export const MIN_OF_FIT_PAGE = 0.5
/** The largest bitmap one page may be painted as, in DEVICE pixels. */
export const MAX_PAGE_DEVICE_PIXELS = 2 ** 24

/**
 * The zoom range for one page in one viewport.
 * @param {{ fitPage: number, fitWidth: number, width: number, height: number, dpr?: number }} p
 *        `width`/`height` are the page's intrinsic (scale-1) size; `fitPage`/`fitWidth` are the scales
 *        the two fit modes resolve to for that page in the current viewport.
 * @returns {{ min: number, max: number }}
 */
export function zoomBounds({ fitPage, fitWidth, width, height, dpr = 1 }) {
    const fp = fitPage > 0 ? fitPage : 1
    const fw = fitWidth > 0 ? fitWidth : fp
    const min = fp * MIN_OF_FIT_PAGE
    const area = width > 0 && height > 0 ? width * height : 0
    const budget = area ? Math.sqrt(MAX_PAGE_DEVICE_PIXELS / area) / (dpr > 0 ? dpr : 1) : fw
    // Both fits always lie inside the range, so neither can ever be clamped by it.
    const max = Math.max(budget, fw, fp)
    return { min: Math.min(min, max), max }
}

/** A numeric zoom, held to the range. */
export const clampZoom = (z, { min, max }) => Math.min(max, Math.max(min, z))
