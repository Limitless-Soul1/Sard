import { useI18n } from "../../i18n";
import { ReadingSettings } from "./ReadingSettings";
import type { ReadingStyle } from "../../reader-engine/injectedCss";

interface Props {
  open: boolean;
  onClose: () => void;
  style: ReadingStyle;
  update: (patch: Partial<ReadingStyle>) => void;
  isRtlBook: boolean;
}

// The reading-settings slide-over (band D). A calm, sectioned panel hosting the rebuilt
// ReadingSettings (RAWY-24) — every control wired to the existing funnel/theme/i18n logic.
export function SettingsPanel({ open, onClose, style, update, isRtlBook }: Props) {
  const { t } = useI18n();
  return (
    <>
      <div className={`panel-scrim${open ? " show" : ""}`} onClick={onClose} />
      {/* Side = BOOK direction (book-trailing edge), independent of the UI language, so the
          slide-over never shares an edge with the book-leading chapters panel (RAWY-28). */}
      <aside
        className={`settings-panel ${isRtlBook ? "sp-rtl" : "sp-ltr"}${open ? " show" : ""}`}
        aria-hidden={!open}
      >
        <div className="sp-head">
          <span className="sp-title">{t("reader.settings")}</span>
          <button className="rc-icon" onClick={onClose} title={t("reader.settings")}>✕</button>
        </div>
        <div className="sp-body">
          <ReadingSettings style={style} update={update} isRtlBook={isRtlBook} />
        </div>
      </aside>
    </>
  );
}
