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
}: Props) {
  const { t } = useI18n();
  const tabs: { key: SettingsSection; label: string }[] = [
    { key: "text", label: t("reader.text") },
    { key: "page", label: t("settings.page") },
    { key: "theme", label: t("theme.label") },
  ];
  return (
    <aside className={`settings-panel${open ? " show" : ""}`} aria-hidden={!open}>
      <div className="sp-head">
        <span className="sp-title">{t("reader.settings")}</span>
        <button className="rc-icon" onClick={onClose} title={t("reader.settings")} aria-label="✕">✕</button>
      </div>
      {/* Per-book scope banner (RAWY-40, Band I) — "applies to this book; won't change others" + Reset. */}
      <div className="sp-scope">
        <span className="sp-scope-ico" aria-hidden>▤</span>
        <span className="sp-scope-text">
          <span className="sp-scope-title">{t("perbook.scope")}</span>
          <span className="sp-scope-sub" dir="auto">
            {(bookTitle ? `${bookTitle} · ` : "") + t("perbook.scopeSub")}
          </span>
        </span>
        <button className="sp-reset" onClick={onReset} disabled={!hasOverride} title={t("perbook.reset")}>
          ↻ {t("perbook.reset")}
        </button>
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
        />
      </div>
    </aside>
  );
}
