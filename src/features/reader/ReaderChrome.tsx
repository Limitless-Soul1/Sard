import { useI18n } from "../../i18n";

export type SettingsSection = "text" | "page" | "theme";

interface Props {
  visible: boolean;
  bookTitle: string | null;
  chapter: string;
  fraction: number;
  onBack: () => void;
  onContents: () => void;
  onText: () => void;
  onTheme: () => void;
  onLayout: () => void;
  onAnnotations: () => void;
  onBookmark: () => void;
  chaptersOpen: boolean;
  annoOpen: boolean;
  settingsOpen: boolean;
  settingsSection: SettingsSection;
}

// Reading chrome (RAWY-33, design bands C-VI / C-VII): a cohesive full-width top bar with
// CLEAR, LABELLED controls (the old faint icons were the complaint) and a bottom progress
// bar. NO logo — the page is the hero. The chrome is PINNED (RAWY-32/D21): nav on the
// physical LEFT, the control cluster on the physical RIGHT — they do NOT flip with the UI
// language (the bar forces `direction: ltr`). Only labels translate; the reading TEXT and the
// page-turn chevrons follow the BOOK. Contents opens the LEFT panel, Notes the RIGHT panel;
// Text/Theme/Layout open the settings slide-over at the matching section.
export function ReaderChrome({
  visible,
  bookTitle,
  chapter,
  fraction,
  onBack,
  onContents,
  onText,
  onTheme,
  onLayout,
  onAnnotations,
  onBookmark,
  chaptersOpen,
  annoOpen,
  settingsOpen,
  settingsSection,
}: Props) {
  const { t } = useI18n();
  const pct = Math.round(fraction * 100);

  return (
    <div className={`reader-chrome${visible ? " show" : ""}`} aria-hidden={!visible}>
      <div className="rc-top">
        {/* left nav: back + book/chapter context */}
        <div className="rc-nav">
          <button className="rc-back" onClick={onBack} title={t("reader.back")}>‹</button>
          <div className="rc-title-block">
            <span className="rc-book" dir="auto">{bookTitle || t("reader.untitledBook")}</span>
            <span className="rc-chapter" dir="auto">{chapter}</span>
          </div>
        </div>

        {/* right controls: bordered, labelled buttons (pinned to the right) */}
        <div className="rc-btns">
          <button className={`rc-btn${chaptersOpen ? " on" : ""}`} onClick={onContents} title={t("reader.contents")}>
            <span className="rc-btn-ico"><span className="ico-lines"><span /><span /><span /></span></span>
            <span className="rc-btn-label">{t("reader.contents")}</span>
          </button>
          <button
            className={`rc-btn${settingsOpen && settingsSection === "text" ? " on" : ""}`}
            onClick={onText}
            title={t("reader.text")}
          >
            <span className="rc-btn-ico ico-aa">A<span>a</span></span>
            <span className="rc-btn-label">{t("reader.text")}</span>
          </button>
          <button
            className={`rc-btn${settingsOpen && settingsSection === "theme" ? " on" : ""}`}
            onClick={onTheme}
            title={t("theme.label")}
          >
            <span className="rc-btn-ico"><span className="ico-half" /></span>
            <span className="rc-btn-label">{t("theme.label")}</span>
          </button>
          <button
            className={`rc-btn${settingsOpen && settingsSection === "page" ? " on" : ""}`}
            onClick={onLayout}
            title={t("reader.layout")}
          >
            <span className="rc-btn-ico"><span className="ico-cols"><span /><span /></span></span>
            <span className="rc-btn-label">{t("reader.layout")}</span>
          </button>
          <button className="rc-btn" onClick={onBookmark} title={t("reader.bookmark")}>
            <span className="rc-btn-ico"><span className="ico-ribbon" /></span>
            <span className="rc-btn-label">{t("reader.bookmark")}</span>
          </button>
          <span className="rc-divider" aria-hidden />
          <button className={`rc-btn${annoOpen ? " on" : ""}`} onClick={onAnnotations} title={t("reader.notes")}>
            <span className="rc-btn-ico"><span className="ico-note" /></span>
            <span className="rc-btn-label">{t("reader.notes")}</span>
          </button>
        </div>
      </div>

      <div className="rc-bottom">
        <div className="rc-meta">
          <span dir="auto">{chapter}</span>
          <span>{pct}%</span>
        </div>
        <div className="rc-progress">
          <div className="rc-progress-fill" style={{ width: `${pct}%` }} />
          <div className="rc-progress-knob" style={{ left: `${pct}%` }} />
        </div>
      </div>
    </div>
  );
}
