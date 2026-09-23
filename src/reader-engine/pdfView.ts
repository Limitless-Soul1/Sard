// PDF PRESENTATION MODEL — reading themes and the zoom lattice for fixed-layout (PDF) books.
//
// WHY THIS IS A SEPARATE MODULE. A PDF page is a RASTER: foliate's pdf.js wrapper paints the page to a
// canvas and copies the pixels into an <img> (see public/foliate-js/pdf.js). Nothing about it can be
// restyled the way an EPUB's DOM can — there is no text to recolour, no stylesheet to inject. So a
// "theme" for a PDF is necessarily a colour TRANSFORM applied to the finished image, and the honest
// name for that is a filter chain, not a theme in the EPUB sense.
//
// That constraint is also why the themes below are tuned rather than invented: a filter that looks
// pleasant on a white text page can destroy a scanned page whose paper is already grey-brown, and four
// of the six PDFs in the test corpus are scans with no text layer at all.

/** One PDF reading appearance. `filter` transforms the rendered page; `desk` tints the surround. */
export type PdfThemeId = "normal" | "sepia" | "warm" | "cream" | "green" | "grey" | "night" | "ink";

export type PdfTheme = {
  id: PdfThemeId;
  /** i18n key, spelled out rather than built from the id so the key union stays checkable. */
  labelKey: `pdf.theme.${PdfThemeId}`;
  /** CSS filter chain applied to the rendered page image. Paper TINTING is done by a multiply blend
   *  in global.css, not here: measured on a real scan, sepia() moved the page by 6-14/255 and was
   *  invisible, because scan paper is already grey rather than white. */
  filter: string;
  /** Paper tint, composited over the page with mix-blend-mode: multiply. This is what makes a light
   *  theme visible on a scan; a hue filter alone is not. */
  tint: string;
  /** Reading-surface colour behind and around the page, so a dark page is not framed in white. */
  desk: string;
  /** True for themes that invert luminance — the page is light-on-dark when applied. */
  dark: boolean;
};

// Ordered as they appear in the panel: light and paper-like first, then the dark ones.
export const PDF_THEMES: PdfTheme[] = [
  { id: "normal", labelKey: "pdf.theme.normal", filter: "none", tint: "transparent", desk: "", dark: false },
  // Classic sepia. Kept below 0.5 because scans already carry a yellow cast and stack with it.
  { id: "sepia", labelKey: "pdf.theme.sepia", filter: "contrast(0.96) brightness(1.04)", tint: "#d9b982", desk: "#e4d3b0", dark: false },
  // Warm paper: a gentler warmth than sepia, aimed at long sessions rather than nostalgia.
  { id: "warm", labelKey: "pdf.theme.warm", filter: "contrast(0.97) brightness(1.05)", tint: "#e6cda3", desk: "#edddc0", dark: false },
  // Cream: barely tinted, mostly a glare reduction for bright rooms.
  { id: "cream", labelKey: "pdf.theme.cream", filter: "contrast(0.96) brightness(1.06)", tint: "#f0e2c0", desk: "#f4ecd8", dark: false },
  // Soft green: the classic low-fatigue tint. Hue-rotated off sepia so scans stay neutral, not lurid.
  { id: "green", labelKey: "pdf.theme.green", filter: "contrast(0.96) brightness(1.05)", tint: "#bfdcc0", desk: "#d3e5d2", dark: false },
  // Grey: a softened inversion. Full invert on a scan turns paper grain into visible noise; pulling
  // contrast down and stopping short of pure black keeps the grain quiet.
  { id: "grey", labelKey: "pdf.theme.grey", filter: "invert(0.9) hue-rotate(180deg) contrast(0.86) brightness(0.98)", tint: "transparent", desk: "#2b2b2e", dark: true },
  // Night: full inversion, dimmed. This is the existing "inverted" appearance, tuned.
  { id: "night", labelKey: "pdf.theme.night", filter: "invert(1) hue-rotate(180deg) brightness(0.9) contrast(1.06)", tint: "transparent", desk: "#16181c", dark: true },
  // Ink: high contrast for faint or badly exposed scans — the most common defect in the corpus.
  { id: "ink", labelKey: "pdf.theme.ink", filter: "grayscale(1) contrast(1.75) brightness(0.94)", tint: "transparent", desk: "#dcdce0", dark: false },
];

export const PDF_THEME_IDS: PdfThemeId[] = PDF_THEMES.map((t) => t.id);
export const isPdfThemeId = (v: string | null | undefined): v is PdfThemeId =>
  !!v && PDF_THEME_IDS.includes(v as PdfThemeId);
export const pdfTheme = (id: string | null | undefined): PdfTheme =>
  PDF_THEMES.find((t) => t.id === id) ?? PDF_THEMES[0];

// ---- zoom -----------------------------------------------------------------------------------
//
// The renderer already understands zoom: `fixed-layout.js` observes a `zoom` attribute accepting a
// number, "fit-width" or "fit-page", and re-renders the page THROUGH pdf.js at that scale rather than
// upscaling the existing bitmap. That matters — it means zooming a scan yields real resolution, not a
// blurry magnification. Sard simply never set the attribute, so the renderer sat at its default
// (fit-page), which is why a PDF could not be zoomed at all.

export type PdfZoom = number | "fit-width" | "fit-page";

// THE RANGE IS THE RENDERER'S, NOT THESE NUMBERS. How small a page may get and how large it may be
// painted depend on the page and the window (see public/foliate-js/sard-zoom.js), so each renderer
// holds a numeric zoom to that range itself and reports it (`zoomBounds`). The interface reads the
// same numbers back. The two constants below only SANITISE a stored or computed value on its way in
// (a corrupt row, a runaway delta); they are deliberately wider than any real range and never decide
// what a reader sees. The fixed 0.5x–6x range and its step ladder that used to live here are gone:
// 0.5x was a third of the window on a large screen and two thirds on a small one.
export const PDF_ZOOM_MIN = 0.05;
export const PDF_ZOOM_MAX = 32;

/** A zoom range as the renderer reports it. */
export type PdfZoomRange = { min: number; max: number };

export const clampPdfZoom = (z: number, range?: PdfZoomRange | null): number => {
  const lo = range ? Math.max(PDF_ZOOM_MIN, range.min) : PDF_ZOOM_MIN;
  const hi = range ? Math.min(PDF_ZOOM_MAX, range.max) : PDF_ZOOM_MAX;
  return Math.min(hi, Math.max(lo, Math.round(z * 1000) / 1000));
};

/**
 * Continuous zoom for a wheel/pinch delta. Exponential so the gesture feels linear to the hand: the
 * same wheel movement changes the picture by the same PROPORTION whether at 0.5x or 4x.
 *
 * A trackpad pinch arrives as a wheel event with `ctrlKey` set and small deltas; a mouse wheel with
 * Ctrl held arrives with large ones. Dividing by a constant makes the mouse crawl or the pinch bolt,
 * so the delta is capped before it is applied.
 */
export function zoomForWheel(current: number, deltaY: number, range?: PdfZoomRange | null): number {
  const d = Math.max(-60, Math.min(60, deltaY));
  return clampPdfZoom(current * Math.exp(-d / 320), range);
}

export const isFitMode = (z: PdfZoom): z is "fit-width" | "fit-page" => typeof z === "string";

// ---- THE ZOOM SLIDER'S SCALE ------------------------------------------------------------------
//
// LOGARITHMIC, for the reason the wheel zoom above is exponential: zoom is a PROPORTION. On a linear
// 50%–600% track, 100%–200% — where nearly all reading happens — would be the first sixth of the
// travel, and a pixel of drag near the top would be worth ten near the bottom. Here every equal stretch
// of the track is an equal proportional change: one position unit is 1/100 of a doubling.
//
// Its ENDS are the renderer's range for the page on screen, so the far left is the smallest page that
// range allows and the far right the largest — never a position that does nothing.
/** Scale → slider position. */
export const zoomToSlider = (z: number): number => Math.round(100 * Math.log2(Math.max(z, 1e-3)));
/** The slider's two ends for a range. */
// Rounded OUTWARD, so the two ends reach the range's ends exactly; anything beyond them is clamped.
export const sliderBounds = (range: PdfZoomRange): { min: number; max: number } => ({
  min: Math.floor(100 * Math.log2(range.min)),
  max: Math.ceil(100 * Math.log2(range.max)),
});
/** Slider position → scale, held to the same range every other zoom path uses. */
export const sliderToZoom = (v: number, range?: PdfZoomRange | null): number => clampPdfZoom(2 ** (v / 100), range);

/** The value handed to the renderer's `zoom` attribute. */
export const pdfZoomAttr = (z: PdfZoom): string => (isFitMode(z) ? z : String(z));

/** Per-document memory. Zoom is a property of the document being read, not a global preference. */
export const pdfZoomKey = (bookId: string): string => `pdf.zoom.${bookId}`;
export const PDF_THEME_KEY = "pdf.theme";

// ---- HOW A PDF IS READ: one continuous flow, or one page at a time ---------------------------
//
// THE MEASUREMENT THIS SETTING EXISTS FOR. In the paged renderer the amount a wheel gesture means is
// a function of the zoom, because the only thing there is to scroll is the ONE page on screen. On a
// 567-page PDF at a 705px viewport, measured in the running application:
//
//     fit-page (the default)   0 px of travel    -> the FIRST wheel notch turns the page
//     fit-width              314 px of travel    -> four notches cross it, the fifth turns it
//     zoom 2                 635 px              -> seven
//     zoom 3                1305 px              -> twelve
//
// The wheel handling itself was measured correct at every delta. The defect is that a page boundary
// was doing the job of a scroll boundary, so an ordinary gesture jumped a whole page. Scroll mode
// removes the question by giving the reader a document to scroll; Pages mode keeps the paginated
// reading some documents (and some readers) want.
export type PdfViewMode = "scroll" | "pages";

/** Scroll is the default: a PDF is a document, and a document scrolls. */
export const PDF_VIEW_MODE_DEFAULT: PdfViewMode = "scroll";

/**
 * ONE GLOBAL KEY, matching the convention the rest of the reading settings follow.
 *
 * Sard deliberately has ONE level of reading preference (see `features/reader/perBookSettings.ts`:
 * the per-book override was removed because two owners of the same field is what made a هيئة unable
 * to change a book that had once been tuned). A per-book mode would reintroduce exactly that, so
 * this is an installation preference like every other reading setting — and it needs no migration,
 * because an absent key simply reads as the default.
 */
export const PDF_VIEW_MODE_KEY = "pdf_view_mode";

export const isPdfViewMode = (v: string | null | undefined): v is PdfViewMode =>
  v === "scroll" || v === "pages";

/** What a stored value means. Anything unrecognised — including an absent key — is the default. */
export const parsePdfViewMode = (v: string | null | undefined): PdfViewMode =>
  isPdfViewMode(v) ? v : PDF_VIEW_MODE_DEFAULT;

// ---- HOW MUCH OF THE READING SHEET SHOWS AROUND A PDF PAGE -----------------------------------
//
// The area around a PDF page is `.page-sheet`: the EPUB paper (its colour, edge shadow and grain),
// which a PDF inherits but does not need, because a PDF page is its own paper. This setting changes
// how much of that one layer is painted. It is presentation only — no size, zoom, gap or position
// depends on it, so it applies live without reopening the book.
export type PdfSurround = "normal" | "reduced" | "none";

/** Normal is today's presentation, so an absent key changes nothing for anyone. */
export const PDF_SURROUND_DEFAULT: PdfSurround = "normal";

/** Global, like the PDF appearance: how a reader likes pages framed is not a property of one file. */
export const PDF_SURROUND_KEY = "pdf_surround";

export const isPdfSurround = (v: string | null | undefined): v is PdfSurround =>
  v === "normal" || v === "reduced" || v === "none";

export const parsePdfSurround = (v: string | null | undefined): PdfSurround =>
  isPdfSurround(v) ? v : PDF_SURROUND_DEFAULT;

// ---- HOW FAR THE SURROUND EXTENDS BEYOND THE PAGE ------------------------------------------------
//
// The width, in CSS px, of the surround on EACH side of the page — a frame that follows the page at every
// zoom. ABSENT means "as it has always been": the sheet spans the whole reading column, exactly as before
// this setting existed, so nobody's reader changes until they move the slider. Global, like the rest.
export const PDF_FRAME_KEY = "pdf_surround_frame";

/**
 * WHERE THE FRAME GOES. Pure geometry, in viewport px, from boxes the Reader can measure:
 * the reading area (the desk beside any open panel), the sheet, the page-host, and the renderer's own
 * report of where the page sits across its box. The frame is `frame` px of surround on each side of the
 * page, never wider than the reading area, and never pushed off it.
 *
 * `max` is the frame that reaches the whole reading area for this page at this zoom: the slider's far
 * end. `current` is where the untouched surround (the whole sheet) sits on that scale, so an untouched
 * slider shows the look the reader already has.
 */
export function pdfBand(o: {
  areaLeft: number; areaRight: number; sheetLeft: number; sheetWidth: number; hostLeft: number; hostWidth: number;
  boxWidth: number; pageWidth: number; pageCenterX: number; frame: number | null;
}): { width: number; x: number; max: number; current: number } {
  const areaW = Math.max(0, o.areaRight - o.areaLeft);
  const max = Math.max(0, Math.floor((areaW - o.pageWidth) / 2));
  const current = Math.min(max, Math.max(0, Math.floor((o.sheetWidth - o.pageWidth) / 2)));
  const f = Math.min(max, Math.max(0, o.frame ?? current));
  const width = Math.min(areaW, o.pageWidth + 2 * f);
  const pageCenter = o.hostLeft + (o.hostWidth - o.boxWidth) / 2 + o.pageCenterX;
  const center = Math.min(o.areaRight - width / 2, Math.max(o.areaLeft + width / 2, pageCenter));
  return { width, x: center - o.sheetLeft, max, current };
}

/** A stored frame width, or null for the untouched (whole-column) surround. */
export const parsePdfFrame = (v: string | null | undefined): number | null => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
};

export function parseStoredZoom(raw: string | null | undefined): PdfZoom | null {
  if (!raw) return null;
  if (raw === "fit-width" || raw === "fit-page") return raw;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? clampPdfZoom(n) : null;
}
