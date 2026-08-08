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

export const PDF_ZOOM_MIN = 0.5;
export const PDF_ZOOM_MAX = 6;

/** Multiplicative ladder: equal *perceptual* steps, unlike a fixed +0.1 which crawls when zoomed in. */
export const PDF_ZOOM_STEPS = [0.5, 0.67, 0.8, 1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5, 6];

export const clampPdfZoom = (z: number): number =>
  Math.min(PDF_ZOOM_MAX, Math.max(PDF_ZOOM_MIN, Math.round(z * 1000) / 1000));

/** Next rung up/down the ladder from an arbitrary current scale (which may be a fit-mode's result). */
export function stepPdfZoom(current: number, dir: 1 | -1): number {
  const eps = 1e-4;
  if (dir > 0) return clampPdfZoom(PDF_ZOOM_STEPS.find((s) => s > current + eps) ?? PDF_ZOOM_MAX);
  const below = PDF_ZOOM_STEPS.filter((s) => s < current - eps);
  return clampPdfZoom(below.length ? below[below.length - 1] : PDF_ZOOM_MIN);
}

/**
 * Continuous zoom for a wheel/pinch delta. Exponential so the gesture feels linear to the hand: the
 * same wheel movement changes the picture by the same PROPORTION whether at 0.5x or 4x.
 *
 * A trackpad pinch arrives as a wheel event with `ctrlKey` set and small deltas; a mouse wheel with
 * Ctrl held arrives with large ones. Dividing by a constant makes the mouse crawl or the pinch bolt,
 * so the delta is capped before it is applied.
 */
export function zoomForWheel(current: number, deltaY: number): number {
  const d = Math.max(-60, Math.min(60, deltaY));
  return clampPdfZoom(current * Math.exp(-d / 320));
}

export const isFitMode = (z: PdfZoom): z is "fit-width" | "fit-page" => typeof z === "string";

/** The value handed to the renderer's `zoom` attribute. */
export const pdfZoomAttr = (z: PdfZoom): string => (isFitMode(z) ? z : String(z));

/** Per-document memory. Zoom is a property of the document being read, not a global preference. */
export const pdfZoomKey = (bookId: string): string => `pdf.zoom.${bookId}`;
export const PDF_THEME_KEY = "pdf.theme";

export function parseStoredZoom(raw: string | null | undefined): PdfZoom | null {
  if (!raw) return null;
  if (raw === "fit-width" || raw === "fit-page") return raw;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? clampPdfZoom(n) : null;
}
