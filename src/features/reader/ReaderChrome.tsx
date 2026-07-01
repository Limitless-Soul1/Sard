import { useI18n } from "../../i18n";
import { localeNum } from "../../lib/format";

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
  bookmarked: boolean;
  chaptersOpen: boolean;
  annoOpen: boolean;
  settingsOpen: boolean;
  settingsSection: SettingsSection;
  // Photo-card basket (RAWY-60): appears only when the basket has passages; the badge shows the
  // count; it sits in this pinned cluster (physical side, D21) and opens the passages tray.
  basketCount: number;
  basketOpen: boolean;
  onBasket: () => void;
}

// A small "stack of cards" glyph for the basket button.
const BasketIco = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <rect x="7" y="3.5" width="13" height="13" rx="2.2" /><path d="M4 7.5v11a2 2 0 0 0 2 2h11" />
  </svg>
);

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
  bookmarked,
  chaptersOpen,
  annoOpen,
  settingsOpen,
  settingsSection,
  basketCount,
  basketOpen,
  onBasket,
}: Props) {
  const { t, lang } = useI18n();
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
          {/* Bookmark (RAWY-41): toggles a saved location at the current spot; "on" when the
              visible location is bookmarked. */}
          <button
            className={`rc-btn${bookmarked ? " on" : ""}`}
            onClick={onBookmark}
            title={bookmarked ? t("bookmark.remove") : t("bookmark.add")}
          >
            <span className="rc-btn-ico"><span className="ico-ribbon" /></span>
            <span className="rc-btn-label">{t("reader.bookmark")}</span>
          </button>
          <span className="rc-divider" aria-hidden />
          <button className={`rc-btn${annoOpen ? " on" : ""}`} onClick={onAnnotations} title={t("reader.notes")}>
            <span className="rc-btn-ico"><span className="ico-note" /></span>
            <span className="rc-btn-label">{t("reader.notes")}</span>
          </button>
          {/* Photo-card basket (RAWY-60) — hidden when empty, so normal reading stays clean. */}
          {basketCount > 0 && (
            <button className={`rc-btn rc-basket${basketOpen ? " on" : ""}`} onClick={onBasket} title={t("basket.title")}>
              <span className="rc-btn-ico">
                <BasketIco />
                <span className="rc-basket-badge">{localeNum(basketCount, lang)}</span>
              </span>
              <span className="rc-btn-label">{t("photo.basket")}</span>
            </button>
          )}
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
