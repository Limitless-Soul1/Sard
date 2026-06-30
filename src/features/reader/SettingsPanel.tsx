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
  sectionNonce: number;
}

// The reading-settings slide-over (band D). A calm, sectioned panel hosting the rebuilt
// ReadingSettings (RAWY-24) — every control wired to the existing funnel/theme/i18n logic.
export function SettingsPanel({ open, onClose, style, update, isRtlBook, section, sectionNonce }: Props) {
  const { t } = useI18n();
  return (
    <>
      <div className={`panel-scrim${open ? " show" : ""}`} onClick={onClose} />
      {/* Side follows the UI direction (RAWY-30): the slide-over docks on the UI-trailing edge
          (same side as the toolbar type/theme buttons that open it), opposite the UI-leading
          chapters panel. The CSS keys off <html dir>, so no per-book class is needed. */}
      <aside
        className={`settings-panel${open ? " show" : ""}`}
        aria-hidden={!open}
      >
        <div className="sp-head">
          <span className="sp-title">{t("reader.settings")}</span>
          <button className="rc-icon" onClick={onClose} title={t("reader.settings")}>✕</button>
        </div>
        <div className="sp-body">
          <ReadingSettings
            style={style}
            update={update}
            isRtlBook={isRtlBook}
            section={section}
            sectionNonce={sectionNonce}
          />
        </div>
      </aside>
    </>
  );
}
