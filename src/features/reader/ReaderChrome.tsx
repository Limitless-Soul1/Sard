import { useI18n } from "../../i18n";

interface Props {
  visible: boolean;
  chapter: string;
  fraction: number;
  bookDir: string; // book's own direction — the progress fills from the book's start
  onBack: () => void;
  onContents: () => void;
  onAnnotations: () => void;
  onTypography: () => void;
  onTheme: () => void;
  onBookmark: () => void;
  chaptersOpen: boolean;
  annoOpen: boolean;
}

// Reading chrome (band C): a translucent top bar (back/contents · chapter · type/theme/
// bookmark) and a bottom progress bar. NO logo here — the page is the hero. The chrome
// follows the UI direction (inherits <html dir>); the progress fill follows the BOOK.
export function ReaderChrome({
  visible,
  chapter,
  fraction,
  bookDir,
  onBack,
  onContents,
  onAnnotations,
  onTypography,
  onTheme,
  onBookmark,
  chaptersOpen,
  annoOpen,
}: Props) {
  const { t } = useI18n();
  const pct = Math.round(fraction * 100);

  return (
    <div className={`reader-chrome${visible ? " show" : ""}`} aria-hidden={!visible}>
      <div className="rc-top">
        <div className="rc-group">
          <button className="rc-icon" onClick={onBack} title={t("reader.back")}>‹</button>
          <button
            className={`rc-icon rc-contents${chaptersOpen ? " on" : ""}`}
            onClick={onContents}
            title={t("reader.contents")}
          >
            <span></span><span></span><span></span>
          </button>
        </div>
        <div className="rc-chapter">{chapter}</div>
        <div className="rc-group">
          <button className="rc-icon rc-aa" onClick={onTypography} title={t("reader.typography")}>
            A<span>a</span>
          </button>
          <button
            className={`rc-icon rc-annos${annoOpen ? " on" : ""}`}
            onClick={onAnnotations}
            title={t("panel.annotations")}
          >
            <span></span><span></span><span></span>
          </button>
          <button className="rc-icon" onClick={onTheme} title={t("settings.language")}>◐</button>
          <button className="rc-icon rc-bookmark" onClick={onBookmark} title={t("reader.bookmark")} />
        </div>
      </div>

      <div className="rc-bottom">
        <div className="rc-progress" dir={bookDir === "rtl" ? "rtl" : "ltr"}>
          <div className="rc-progress-fill" style={{ inlineSize: `${pct}%` }} />
        </div>
        <div className="rc-meta">
          <span>{chapter}</span>
          <span>{pct}%</span>
        </div>
      </div>
    </div>
  );
}
