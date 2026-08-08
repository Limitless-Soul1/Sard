import { useI18n } from "../../i18n";
import { ReadingSettings } from "./ReadingSettings";
import type { SettingsSection } from "./ReaderChrome";
import type { ReadingStyle } from "../../reader-engine/injectedCss";
import type { ThemeId } from "../../theme";
import { PDF_THEMES, type PdfZoom, type PdfThemeId } from "../../reader-engine/pdfView";
import { PDF_TTS_ENABLED } from "../../lib/pdfText";

interface Props {
  open: boolean;
  onClose: () => void;
  style: ReadingStyle;
  update: (patch: Partial<ReadingStyle>) => void;
  isRtlBook: boolean;
  section: SettingsSection;
  onSection: (s: SettingsSection) => void;
  // Per-book scope (RAWY-40): the book's own theme + a reset of all its overrides.
  bookThemeId: ThemeId;
  onPickTheme: (id: ThemeId) => void;
  bookTitle: string | null;
  hasOverride: boolean;
  onReset: () => void;
  unified: boolean; // RAWY-43 — the banner + Reset reflect the active book-style scope
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
  onPdfZoomStep?: (dir: 1 | -1) => void;
  onPdfZoomMode?: (mode: "fit-width" | "fit-page") => void;
  onPdfCopy?: () => void;
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
  onPickTheme,
  bookTitle,
  hasOverride,
  onReset,
  unified,
  isPdf,
  pdfThemeId,
  onPdfTheme,
  pdfZoom,
  onPdfZoomStep,
  onPdfZoomMode,
}: Props) {
  const { t } = useI18n();
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
    return (
      <aside className={`settings-panel${open ? " show" : ""}`} aria-hidden={!open} inert={!open}>
        <div className="sp-head">
          <span className="sp-title">{t("pdf.options")}</span>
          <button className="rc-icon" onClick={onClose} title={t("panel.close")} aria-label={t("panel.close")}>✕</button>
        </div>
        <div className="sp-body sp-pdf">
          <div className="sp-pdf-note">
            <div className="sp-pdf-title">{t("pdf.readonly.title")}</div>
            <div className="sp-pdf-body">{t("pdf.readonly.body")}</div>
          </div>

          {/* RAWY-291 · ZOOM. Placed first: it is the control a reader of a scanned book reaches for.
              The percentage reads the mode when a fit is active, because "fit width" is the truth then
              and a stale number beside it would not be. */}
          <div className="rs-sec">
            <div className="rs-sec-head">
              <span className="rs-label">{t("pdf.zoom")}</span>
              <span className="rs-value">
                {pdfZoom === "fit-width" ? t("pdf.zoom.fitWidth")
                  : pdfZoom === "fit-page" ? t("pdf.zoom.fitPage")
                  : `${Math.round((pdfZoom ?? 1) * 100)}%`}
              </span>
            </div>
            <div className="pdf-zoom-row">
              <button className="pdf-zoom-btn" onClick={() => onPdfZoomStep?.(-1)} title={t("pdf.zoom.out")} aria-label={t("pdf.zoom.out")}>−</button>
              <button className="pdf-zoom-btn" onClick={() => onPdfZoomStep?.(1)} title={t("pdf.zoom.in")} aria-label={t("pdf.zoom.in")}>+</button>
              <button className={`pdf-zoom-fit${pdfZoom === "fit-width" ? " on" : ""}`} onClick={() => onPdfZoomMode?.("fit-width")}>
                {t("pdf.zoom.fitWidth")}
              </button>
              <button className={`pdf-zoom-fit${pdfZoom === "fit-page" ? " on" : ""}`} onClick={() => onPdfZoomMode?.("fit-page")}>
                {t("pdf.zoom.fitPage")}
              </button>
            </div>
            <div className="rs-sec-hint">{t("pdf.zoom.hint")}</div>
          </div>

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
        </div>
      </aside>
    );
  }
  return (
    <aside className={`settings-panel${open ? " show" : ""}`} aria-hidden={!open} inert={!open}>
      <div className="sp-head">
        <span className="sp-title">{t("reader.settings")}</span>
        <button className="rc-icon" onClick={onClose} title={t("panel.close")} aria-label={t("panel.close")}>✕</button>
      </div>
      {/* Scope banner (RAWY-40/43) — reflects the active book-style model. Per-book: "applies to
          this book · won't change others" + Reset. Unified: "applies to all books". RAWY-216: the
          title is now composed from the SHARED scope noun rather than its own sentence, so the banner
          and every in-panel scope suffix say the same words. */}
      <div className={`sp-scope${unified ? " unified" : ""}`}>
        <span className="sp-scope-ico" aria-hidden>{unified ? "⊞" : "▤"}</span>
        <span className="sp-scope-text">
          <span className="sp-scope-title">
            {t("perbook.appliesTo")} {unified ? t("scope.allBooks") : t("scope.thisBook")}
          </span>
          <span className="sp-scope-sub" dir="auto">
            {unified ? t("perbook.scopeAllSub") : (bookTitle ? `${bookTitle} · ` : "") + t("perbook.scopeSub")}
          </span>
        </span>
        {!unified && (
          <button className="sp-reset" onClick={onReset} disabled={!hasOverride} title={t("perbook.reset")}>
            ↻ {t("perbook.reset")}
          </button>
        )}
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
          onPickTheme={onPickTheme}
          unified={unified}
        />
      </div>
    </aside>
  );
}
