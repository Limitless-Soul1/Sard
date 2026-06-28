import { useI18n } from "../../i18n";
import { TypographyBar } from "./TypographyBar";
import type { ReadingStyle } from "../../reader-engine/injectedCss";

interface Props {
  open: boolean;
  onClose: () => void;
  style: ReadingStyle;
  update: (patch: Partial<ReadingStyle>) => void;
  onPrev: () => void;
  onNext: () => void;
  status: string;
  book: "ar" | "en";
  onBook: (which: "ar" | "en") => void;
}

// Minimal settings slide-over (band D is a "calm slide-over"; the full settings screen is
// a later task). For now it hosts the existing, working controls (typography + theme +
// language + dev book switcher) so nothing regresses while the reading view is redesigned.
export function SettingsPanel({ open, onClose, ...bar }: Props) {
  const { t } = useI18n();
  return (
    <>
      <div className={`panel-scrim${open ? " show" : ""}`} onClick={onClose} />
      <aside className={`settings-panel${open ? " show" : ""}`} aria-hidden={!open}>
        <div className="sp-head">
          <span className="sp-title">{t("reader.settings")}</span>
          <button className="rc-icon" onClick={onClose} title={t("reader.settings")}>✕</button>
        </div>
        <div className="sp-body">
          <TypographyBar {...bar} />
        </div>
      </aside>
    </>
  );
}
