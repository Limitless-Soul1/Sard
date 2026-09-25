import { useI18n } from "../../i18n";
import { ReadingSettings, Section, Segmented, Slider } from "./ReadingSettings";
import { Icon } from "../../components/Icon";
import type { SettingsSection } from "./ReaderChrome";
import type { ReadingStyle } from "../../reader-engine/injectedCss";
import type { ThemeId } from "../../theme";
import { PDF_THEMES, sliderBounds, sliderToZoom, zoomToSlider, type PdfZoom, type PdfZoomRange, type PdfThemeId, type PdfViewMode, type PdfSurround } from "../../reader-engine/pdfView";
import { PDF_TTS_ENABLED } from "../../lib/pdfText";

interface Props {
  open: boolean;
  onClose: () => void;
  style: ReadingStyle;
  update: (patch: Partial<ReadingStyle>) => void;
  isRtlBook: boolean;
  section: SettingsSection;
  onSection: (s: SettingsSection) => void;
  // The paper on screen (this book's own, else the هيئة's) and what the هيئة itself says — two
  // questions, because the swatches write the second while the page shows the first.
  bookThemeId: ThemeId;
  appearanceThemeId: ThemeId;
  onPickTheme: (id: ThemeId) => void;
  /** The page colour and the ink — they edit the هيئة this book wears, not a shared row. */
  onPickReadingColour?: (slot: "paperBg" | "text", hex: string | null) => void;
  // THIS BOOK'S OWN هيئة, `null` = follows the worn one. An identifier, never a copy of what it
  // names. Passed straight through to the Colour tab.
  bookAppearanceId?: string | null;
  onPickBookAppearance?: (id: string | null) => void;
  // RAWY-85/86: for a PDF the drawer becomes a "read-only" panel. RAWY-141 pared it to what actually
  // works on a fixed-layout PDF — the honest limits, an INVERT appearance (approximate night mode, NOT
  // real themes), and copy-selection. The reading-direction toggle (cosmetic on a fixed-layout PDF) and
  // the in-PDF find (unreliable for Arabic text layers + a cramped misfit) were removed.
  isPdf?: boolean;
  // RAWY-291: the two-state invert became a set of reading appearances, and the renderer's zoom (which
  // re-renders through pdf.js, so it gains real resolution) is exposed here and on Ctrl+Wheel.
  pdfThemeId?: PdfThemeId;
  onPdfTheme?: (id: PdfThemeId) => void;
  pdfZoom?: PdfZoom;
  onPdfZoomMode?: (mode: "fit-width" | "fit-page") => void;
  /** How a PDF is read: one continuous flow, or one page at a time. */
  pdfMode?: PdfViewMode;
  /** The scale actually on screen — a fit mode resolves to a number only in the renderer. */
  pdfScale?: number;
  /** Set an exact zoom — the slider's path. */
  onPdfZoomTo?: (zoom: number) => void;
  /** The renderer's zoom range for the page on screen; the slider's two ends. */
  pdfZoomRange?: PdfZoomRange | null;
  onPdfMode?: (mode: PdfViewMode) => void;
  /** How much of the reading sheet shows around a PDF page — presentation only. */
  pdfSurround?: PdfSurround;
  onPdfSurround?: (v: PdfSurround) => void;
  /** px of surround on each side of the page; null = the whole reading column (never touched). */
  pdfFrame?: number | null;
  /** The frame slider's far end for the page on screen, and where the untouched surround sits on it. */
  pdfFrameInfo?: { max: number; current: number } | null;
  onPdfFrame?: (v: number) => void;
  onPdfCopy?: () => void;
  /**
   * THIS BOOK's answer about pronouncing decorative marks, the هيئة's, and the setter.
   *
   * Per book, like the zoom above and unlike the PDF appearance beside it: whether a particular book's
   * formatting marks are worth hearing is a property of how that book was typed, not of the reader.
   * `null` = not asked, which is how a book goes back to following the worn هيئة.
   */
  speakSymbolsOverride?: boolean | null;
  speakSymbolsAppearance?: boolean;
  onSpeakSymbols?: (v: boolean | null) => void;
}

// The reading-settings drawer (RAWY-34, design band I). A right-edge drawer docked BETWEEN the
// reading bars (no scrim) so the top control cluster stays clickable above it — consistent with
// the Contents/Notes drawers. Its Text · Page · Theme tabs split the RAWY-24 controls so the
// chrome's Text/Theme/Layout buttons each land on a DISTINCT view. Pinned RIGHT (RAWY-32/D21);
// mutually exclusive with the Notes drawer; coexists with the left Contents drawer. RAWY-40 adds
// a PER-BOOK scope banner: everything here overrides THIS book only (vs Global Settings = app-wide).
export function SettingsPanel({
  open,
  onClose,
  style,
  update,
  isRtlBook,
  section,
  onSection,
  bookThemeId,
  appearanceThemeId,
  onPickTheme,
  onPickReadingColour,
  bookAppearanceId,
  onPickBookAppearance,
  isPdf,
  pdfThemeId,
  onPdfTheme,
  pdfZoom,
  onPdfZoomMode,
  pdfMode,
  pdfScale,
  onPdfZoomTo,
  pdfZoomRange,
  onPdfMode,
  pdfSurround,
  onPdfSurround,
  pdfFrame,
  pdfFrameInfo,
  onPdfFrame,
  speakSymbolsOverride,
  speakSymbolsAppearance,
  onSpeakSymbols,
}: Props) {
  const { t, dir: uiDir } = useI18n();
  // RAWY-216: five CONCEPT tabs (was Text/Page/Theme, which mixed typography with colour and read-aloud).
  // The bar wraps to a second row when five labels don't fit the 384px drawer — same pill styling.
  const tabs: { key: SettingsSection; label: string }[] = [
    { key: "typography", label: t("reader.typography") },
    { key: "layout", label: t("reader.layout") },
    { key: "colour", label: t("settings.colour") },
    { key: "readaloud", label: t("settings.readaloud") },
    { key: "allbooks", label: t("settings.allbooks") },
  ];
  // RAWY-85/86/141: a PDF is read-only — the drawer states the honest limits, then offers only what
  // genuinely works on a fixed-layout PDF: an INVERT appearance (approximate night mode, NOT real
  // themes) and copy-selection. One consistent inset (the `sp-body` padding); the sections stack with
  // an even rhythm so the menu reads as a tidy, PDF-appropriate panel (RAWY-141).
  if (isPdf) {
    // The track's ends are the renderer's range for this page in this window (see sard-zoom.js). Until
    // the renderer has reported one, a neutral 50%–400% keeps the control usable.
    const zoomTrack = sliderBounds(pdfZoomRange ?? { min: 0.5, max: 4 });
    return (
      // THE PANEL TAKES THE INTERFACE'S DIRECTION. `.settings-panel` sets no `dir`, and it sits inside
      // `.reader-root`, which is pinned LTR (RAWY-89) — so in Arabic every label, hint and choice in this
      // panel resolved LTR: labels on the left, choices in the wrong order, and each hint's full stop
      // printed at its START («.تتتابع الصفحات…»). MEASURED: html `rtl`, this panel `ltr`; the reader's
      // own screenshot of the previous panel shows the same. Stated here, for the PDF panel only: the
      // EPUB drawer shares the cause but its sliders are documented to depend on the LTR resolution
      // (RAWY-65), so changing it belongs to its own piece of work.
      <aside className={`settings-panel${open ? " show" : ""}`} dir={uiDir} aria-hidden={!open} inert={!open}>
        <div className="sp-head">
          <span className="sp-title">{t("pdf.options")}</span>
          <button className="rc-icon ui-close" onClick={onClose} title={t("panel.close")} aria-label={t("panel.close")}>✕</button>
        </div>
        <div className="sp-body sp-pdf">
          {/* THE ORDER IS THE HIERARCHY: how the document moves, then how big it is, then how it looks.
              Each is a SECTION with its label, built from the same `Section` and `Segmented` the rest of
              the reading settings use — so a PDF's controls look, press and focus exactly like an
              EPUB's, and the reader meets one control language. The "view only" note used to open the
              panel as a boxed callout; it is a limitation, not a control, so it now closes it. */}

          {/* 1 · HOW THE DOCUMENT MOVES. Same label and same two words as the EPUB's own flow choice.
              The hint describes ONLY the active mode, and says the one thing a reader could not guess:
              in Pages mode the wheel stays on the page and the page is turned deliberately. */}
          <Section label={t("pdf.mode")}>
            <Segmented<PdfViewMode>
              label={t("pdf.mode")}
              value={pdfMode ?? "scroll"}
              onPick={(m) => onPdfMode?.(m)}
              options={[
                { key: "scroll", label: t("pdf.mode.scroll") },
                { key: "pages", label: t("pdf.mode.pages") },
              ]}
            />
            <div className="rs-sec-hint">{t((pdfMode ?? "scroll") === "pages" ? "pdf.mode.pagesHint" : "pdf.mode.scrollHint")}</div>
          </Section>

          {/* 2 · ZOOM. The two fits, then a SLIDER — Sard's own reading-settings slider — for everything
              between. The section's value is the scale ACTUALLY on screen, so choosing «الصفحة كاملة»
              visibly answers "and what size is that?", and the thumb sits where that scale is. Neither
              fit is marked once the slider has moved, because neither is true then.
              The track is logarithmic (see `zoomToSlider`): equal travel is an equal proportional change,
              so the 100–200% range most reading happens in is not crowded into one end.
              `pdf-zoom-fit` stays as a HOOK for the behavioural harness, which finds the fits by it. */}
          <Section label={t("pdf.zoom")} value={`${Math.round((pdfScale ?? 1) * 100)}%`}>
            <Segmented<PdfZoom>
              label={t("pdf.zoom")}
              value={pdfZoom ?? "fit-page"}
              onPick={(m) => onPdfZoomMode?.(m as "fit-width" | "fit-page")}
              options={[
                { key: "fit-width", label: t("pdf.zoom.fitWidth"), className: "pdf-zoom-fit" },
                { key: "fit-page", label: t("pdf.zoom.fitPage"), className: "pdf-zoom-fit" },
              ]}
            />
            <Slider
              value={Math.min(zoomTrack.max, Math.max(zoomTrack.min, zoomToSlider(pdfScale ?? 1)))}
              min={zoomTrack.min}
              max={zoomTrack.max}
              step={1}
              onInput={(v) => onPdfZoomTo?.(sliderToZoom(v, pdfZoomRange))}
              lead={<Icon name="minus" size="sm" />}
              trail={<Icon name="plus" size="sm" />}
            />
            <div className="rs-sec-hint">{t("pdf.zoom.hint")}</div>
          </Section>

          {/* Appearance. A PDF page is a rendered image, so these are colour transforms over the page
              rather than EPUB-style themes — see reader-engine/pdfView.ts. */}
          <div className="rs-sec">
            <div className="rs-sec-head"><span className="rs-label">{t("pdf.appearance")}</span></div>
            {/* The preview is a MINIATURE PAGE, not a swatch: paper with text lines, carrying the same
                filter the real page gets and sitting on the same desk colour. A flat swatch was the
                problem before — eight light filters over white read as eight identical white boxes,
                because a filter's effect is only visible on the ink-and-paper it transforms. */}
            <div className="pdf-theme-list" role="group">
              {PDF_THEMES.map((th) => (
                <button
                  key={th.id}
                  className={`pdf-theme-card pdf-chip-${th.id}${(pdfThemeId ?? "normal") === th.id ? " on" : ""}`}
                  onClick={() => onPdfTheme?.(th.id)}
                  title={t(th.labelKey)}
                  aria-label={t(th.labelKey)}
                  aria-pressed={(pdfThemeId ?? "normal") === th.id}
                >
                  <span className="ptp-frame" aria-hidden="true">
                    <span className="ptp-page">
                      <span className="ptp-head" />
                      <span className="ptp-line" />
                      <span className="ptp-line" />
                      <span className="ptp-line short" />
                      <span className="ptp-line" />
                    </span>
                  </span>
                  <span className="pdf-chip-name">{t(th.labelKey)}</span>
                </button>
              ))}
            </div>
            <div className="rs-sec-hint">{t("pdf.appearance.hint")}</div>
          </div>

          {/* The area around the page, not the page: how much of the reading sheet is painted behind a
              PDF. Three discrete strengths, so the same segmented control as the mode above. */}
          <Section label={t("pdf.surround")}>
            <Segmented<PdfSurround>
              label={t("pdf.surround")}
              value={pdfSurround ?? "normal"}
              onPick={(v) => onPdfSurround?.(v)}
              options={[
                { key: "normal", label: t("pdf.surround.normal") },
                { key: "reduced", label: t("pdf.surround.reduced") },
                { key: "none", label: t("pdf.surround.none") },
              ]}
            />
            {/* HOW FAR IT REACHES: a frame that follows the page at every zoom, from snug to the whole
                reading area. Only where there IS a surround — with None there is nothing to size. An
                untouched slider sits where today's surround is, so nothing moves until the reader does. */}
            {(pdfSurround ?? "normal") !== "none" && pdfFrameInfo && pdfFrameInfo.max > 0 && (
              <Slider
                value={Math.min(pdfFrameInfo.max, pdfFrame ?? pdfFrameInfo.current)}
                min={0}
                max={pdfFrameInfo.max}
                step={1}
                onInput={(v) => onPdfFrame?.(v)}
                ariaLabel={t("pdf.surround.size")}
                lead={<span className="rs-tiny">{t("type.narrow")}</span>}
                trail={<span className="rs-tiny">{t("type.wide")}</span>}
              />
            )}
            <div className="rs-sec-hint">{t("pdf.surround.hint")}</div>
          </Section>

          {/* RAWY-292: read-aloud for PDFs is possible but document-dependent, so the panel says so
              rather than letting a reader discover it. The wording is deliberately about the FILE,
              because that is where the limitation lives.
              (The copy-selection button was removed here: it depended on the same text layer that
              measurement showed is absent or damaged in most of these documents.) */}
          {/* TEMPORARY (2026-08-08): hidden while PDF read-aloud is disabled — see `PDF_TTS_ENABLED`
              in lib/pdfText.ts. The note explains how well a given PDF can be READ ALOUD, so leaving
              it visible would advertise a feature the reader has no way to reach. The block and its
              two locale strings are kept, not deleted, so re-enabling restores it unchanged. */}
          {PDF_TTS_ENABLED && (
            <div className="sp-pdf-note sp-pdf-tts">
              <div className="sp-pdf-title">{t("pdf.tts.title")}</div>
              <div className="sp-pdf-body">{t("pdf.tts.body")}</div>
            </div>
          )}

          {/* A LIMITATION, STATED ONCE AND QUIETLY, at the end — where it informs without standing
              between the reader and the controls they opened the panel for. */}
          <p className="sp-pdf-foot">{t("pdf.readonly.body")}</p>
        </div>
      </aside>
    );
  }
  return (
    <aside className={`settings-panel${open ? " show" : ""}`} aria-hidden={!open} inert={!open}>
      <div className="sp-head">
        <span className="sp-title">{t("reader.settings")}</span>
        <button className="rc-icon ui-close" onClick={onClose} title={t("panel.close")} aria-label={t("panel.close")}>✕</button>
      </div>
      <div className="sp-tabs" role="tablist">
        {tabs.map((tb) => (
          <button
            key={tb.key}
            role="tab"
            aria-selected={section === tb.key}
            className={`sp-tab${section === tb.key ? " on" : ""}`}
            onClick={() => onSection(tb.key)}
          >
            {tb.label}
          </button>
        ))}
      </div>
      <div className="sp-body">
        <ReadingSettings
          style={style}
          update={update}
          isRtlBook={isRtlBook}
          section={section}
          bookThemeId={bookThemeId}
          appearanceThemeId={appearanceThemeId}
          onPickTheme={onPickTheme}
          onPickReadingColour={onPickReadingColour}
          bookAppearanceId={bookAppearanceId}
          onPickBookAppearance={onPickBookAppearance}
          speakSymbolsOverride={speakSymbolsOverride}
          speakSymbolsAppearance={speakSymbolsAppearance}
          onSpeakSymbols={onSpeakSymbols}
        />
      </div>
    </aside>
  );
}
