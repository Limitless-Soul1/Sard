import { useState } from "react";

import { useI18n } from "../../i18n";
import { ReadingSettings } from "./ReadingSettings";
import type { SettingsSection } from "./ReaderChrome";
import type { ReadingStyle } from "../../reader-engine/injectedCss";
import type { ThemeId } from "../../theme";

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
  // RAWY-85/86: for a PDF the drawer becomes a "read-only" panel — the honest limits, a reading-
  // direction override (no spine page-progression), an INVERT appearance (approximate night mode,
  // NOT real themes), a basic in-PDF find, and copy-selection.
  isPdf?: boolean;
  pdfDir?: "ltr" | "rtl";
  onPdfDir?: (d: "ltr" | "rtl") => void;
  pdfInvert?: boolean;
  onPdfInvert?: () => void;
  onPdfFind?: (q: string) => void;
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
  pdfDir,
  onPdfDir,
  pdfInvert,
  onPdfInvert,
  onPdfFind,
  onPdfCopy,
}: Props) {
  const { t } = useI18n();
  const [findQ, setFindQ] = useState("");
  const tabs: { key: SettingsSection; label: string }[] = [
    { key: "text", label: t("reader.text") },
    { key: "page", label: t("settings.page") },
    { key: "theme", label: t("theme.label") },
  ];
  // RAWY-85: a PDF is read-only — the drawer states the honest limits + offers a reading-direction
  // override (auto-detect can't know a PDF's direction; an Arabic PDF turns pages right-to-left).
  if (isPdf) {
    return (
      <aside className={`settings-panel${open ? " show" : ""}`} aria-hidden={!open}>
        <div className="sp-head">
          <span className="sp-title">{t("pdf.options")}</span>
          <button className="rc-icon" onClick={onClose} title={t("pdf.options")} aria-label="✕">✕</button>
        </div>
        <div className="sp-body">
          <div className="sp-pdf-note">
            <div className="sp-pdf-title">{t("pdf.readonly.title")}</div>
            <div className="sp-pdf-body">{t("pdf.readonly.body")}</div>
          </div>
          <div className="rs-sec">
            <div className="rs-sec-head"><span className="rs-label">{t("pdf.direction")}</span></div>
            <div className="rs-seg" role="group">
              <button className={`rs-seg-item${pdfDir !== "rtl" ? " on" : ""}`} onClick={() => onPdfDir?.("ltr")}>
                {t("pdf.dir.ltr")}
              </button>
              <button className={`rs-seg-item${pdfDir === "rtl" ? " on" : ""}`} onClick={() => onPdfDir?.("rtl")}>
                {t("pdf.dir.rtl")}
              </button>
            </div>
          </div>

          {/* Appearance: an INVERT filter as an approximate night mode — NOT real themes. */}
          <div className="rs-sec">
            <div className="rs-sec-head"><span className="rs-label">{t("pdf.appearance")}</span></div>
            <div className="rs-seg" role="group">
              <button className={`rs-seg-item${!pdfInvert ? " on" : ""}`} onClick={() => pdfInvert && onPdfInvert?.()}>
                {t("pdf.appearance.normal")}
              </button>
              <button className={`rs-seg-item${pdfInvert ? " on" : ""}`} onClick={() => !pdfInvert && onPdfInvert?.()}>
                {t("pdf.appearance.inverted")}
              </button>
            </div>
            <div className="rs-sec-hint">{t("pdf.appearance.hint")}</div>
          </div>

          {/* Basic in-PDF find — jumps to the first page (from the current one) containing the text. */}
          <div className="rs-sec">
            <div className="rs-sec-head"><span className="rs-label">{t("pdf.find")}</span></div>
            <form
              className="sp-pdf-find"
              onSubmit={(e) => { e.preventDefault(); onPdfFind?.(findQ); }}
            >
              <input
                className="sp-pdf-find-input"
                value={findQ}
                onChange={(e) => setFindQ(e.target.value)}
                placeholder={t("pdf.find.placeholder")}
                dir="auto"
              />
              <button type="submit" className="sp-pdf-find-btn" disabled={!findQ.trim()}>{t("pdf.find.action")}</button>
            </form>
            <div className="rs-sec-hint">{t("pdf.find.hint")}</div>
          </div>

          {/* Copy the current text selection (where the text layer allows). */}
          <button className="sp-pdf-copy" onClick={() => onPdfCopy?.()}>{t("pdf.copy")}</button>
        </div>
      </aside>
    );
  }
  return (
    <aside className={`settings-panel${open ? " show" : ""}`} aria-hidden={!open}>
      <div className="sp-head">
        <span className="sp-title">{t("reader.settings")}</span>
        <button className="rc-icon" onClick={onClose} title={t("reader.settings")} aria-label="✕">✕</button>
      </div>
      {/* Scope banner (RAWY-40/43) — reflects the active book-style model. Per-book: "applies to
          this book · won't change others" + Reset. Unified: "applies to all books". */}
      <div className={`sp-scope${unified ? " unified" : ""}`}>
        <span className="sp-scope-ico" aria-hidden>{unified ? "⊞" : "▤"}</span>
        <span className="sp-scope-text">
          <span className="sp-scope-title">{unified ? t("perbook.scopeAll") : t("perbook.scope")}</span>
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
