import { useI18n } from "../../i18n";
import { ReadingSettings } from "./ReadingSettings";
import type { SettingsSection } from "./ReaderChrome";
import type { ReadingStyle } from "../../reader-engine/injectedCss";

interface Props {
  open: boolean;
  onClose: () => void;
  style: ReadingStyle;
  update: (patch: Partial<ReadingStyle>) => void;
  isRtlBook: boolean;
  section: SettingsSection;
  onSection: (s: SettingsSection) => void;
}

// The reading-settings drawer (RAWY-34, design band I). A right-edge drawer docked BETWEEN the
// reading bars (no scrim) so the top control cluster stays clickable above it — consistent with
// the Contents/Notes drawers. Its Text · Page · Theme tabs split the RAWY-24 controls so the
// chrome's Text/Theme/Layout buttons each land on a DISTINCT view. Pinned RIGHT (RAWY-32/D21);
// mutually exclusive with the Notes drawer; coexists with the left Contents drawer.
export function SettingsPanel({ open, onClose, style, update, isRtlBook, section, onSection }: Props) {
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
        <ReadingSettings style={style} update={update} isRtlBook={isRtlBook} section={section} />
      </div>
    </aside>
  );
}
