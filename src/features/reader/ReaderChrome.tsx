import { useRef, useState } from "react";

import { useI18n } from "../../i18n";
import { localeNum } from "../../lib/format";

// RAWY-216: the settings drawer is grouped by CONCEPT, not by which tab got built first. Five tabs;
// the toolbar's three shortcut buttons (Aa / theme / layout) still land on the three most-used ones,
// and the drawer's tab bar reaches all five (Read-aloud + All books included).
export type SettingsSection = "typography" | "layout" | "colour" | "readaloud" | "allbooks";

interface Props {
  visible: boolean;
  bookTitle: string | null;
  chapter: string;
  fraction: number;
  onBack: () => void;
  onContents: () => void;
  onSearch: () => void; // RAWY-88: in-book search (EPUB only)
  searchOpen: boolean;
  onListen: () => void; // RAWY-105: read-aloud / TTS (EPUB only)
  ttsActive: boolean;
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
  // Photo-card Quotes collection (RAWY-60; user-facing "Quotes"/"اقتباسات" — RAWY-66): appears
  // only when non-empty; the badge shows the count; it sits in this pinned cluster (physical
  // side, D21) and opens the passages tray.
  basketCount: number;
  basketOpen: boolean;
  onBasket: () => void;
  isPdf?: boolean; // RAWY-85: a PDF is read-only — hide the EPUB-only controls
  // RAWY-87 (#1): a PDF has no chapters, so the bottom shows a page position (page / total) and the
  // progress bar is scrubbable to jump anywhere. EPUB is untouched (these are only wired for a PDF).
  pdfPageCount?: number;
  onScrub?: (fraction: number) => void;
}

// A small "stack of cards" glyph for the Quotes button. RAWY-66: 18→20 with the enlarged icon box.
const BasketIco = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
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
  onSearch,
  searchOpen,
  onListen,
  ttsActive,
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
  isPdf,
  pdfPageCount,
  onScrub,
}: Props) {
  const { t, lang } = useI18n();

  // RAWY-87 (#1): PDF scrub. While dragging, the knob + page readout follow the pointer LIVE (cheap
  // math); the actual page jump (onScrub → goToFraction) is driven by the parent, throttled to one
  // in flight. The track is pinned LTR (like the EPUB bar), so fraction = x within the track width.
  const trackRef = useRef<HTMLDivElement>(null);
  const [scrub, setScrub] = useState<number | null>(null);
  const fracFromX = (clientX: number) => {
    const el = trackRef.current;
    if (!el) return 0;
    const r = el.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - r.left) / r.width));
  };
  const scrubDown = (e: React.PointerEvent) => {
    if (!isPdf) return;
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    const f = fracFromX(e.clientX);
    setScrub(f);
    onScrub?.(f);
  };
  const scrubMove = (e: React.PointerEvent) => {
    if (!isPdf || scrub == null) return;
    const f = fracFromX(e.clientX);
    setScrub(f);
    onScrub?.(f);
  };
  const scrubUp = (e: React.PointerEvent) => {
    if (!isPdf || scrub == null) return;
    onScrub?.(scrub);
    setScrub(null);
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
  };

  // Live fraction: the scrub position while dragging, otherwise the real reading fraction.
  const dispFrac = scrub ?? fraction;
  const pct = Math.round(dispFrac * 100);
  // Current page (1-based) from the fraction: RAWY-86 saves (pageIndex+0.5)/count, so pageIndex =
  // round(frac*count − 0.5). Clamped to [1, count].
  const pdfPage = pdfPageCount
    ? Math.min(pdfPageCount, Math.max(1, Math.round(dispFrac * pdfPageCount - 0.5) + 1))
    : 0;

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
          {/* RAWY-88: Search sits FIRST AFTER Contents — the two "find your way" tools together, before
              the appearance tools (design §1). EPUB-only; a PDF keeps its own RAWY-86 find. */}
          {!isPdf && (
            <button className={`rc-btn${searchOpen ? " on" : ""}`} onClick={onSearch} title={t("search.title")}>
              <span className="rc-btn-ico">
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg>
              </span>
              <span className="rc-btn-label">{t("search.title")}</span>
            </button>
          )}
          {/* RAWY-105: Listen (read-aloud) — EPUB-only (Arabic PDF text is unreliable, RAWY-86). */}
          {!isPdf && (
            <button className={`rc-btn${ttsActive ? " on" : ""}`} onClick={onListen} title={t("tts.listen")}>
              <span className="rc-btn-ico">
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M4 10v4M8 7v10M12 4v16M16 8v8M20 11v2" /></svg>
              </span>
              <span className="rc-btn-label">{t("tts.listen")}</span>
            </button>
          )}
          {/* Typography + theme are EPUB-only — hidden for a fixed-layout PDF (RAWY-85). */}
          {!isPdf && (
            <button
              className={`rc-btn${settingsOpen && settingsSection === "typography" ? " on" : ""}`}
              onClick={onText}
              title={t("reader.typography")}
            >
              <span className="rc-btn-ico ico-aa">A<span>a</span></span>
              <span className="rc-btn-label">{t("reader.typography")}</span>
            </button>
          )}
          {!isPdf && (
            <button
              className={`rc-btn${settingsOpen && settingsSection === "colour" ? " on" : ""}`}
              onClick={onTheme}
              title={t("settings.colour")}
            >
              <span className="rc-btn-ico"><span className="ico-half" /></span>
              <span className="rc-btn-label">{t("settings.colour")}</span>
            </button>
          )}
          {/* For a PDF this opens the "read-only" panel (reading direction + honest limits). */}
          <button
            className={`rc-btn${settingsOpen && settingsSection === "layout" ? " on" : ""}`}
            onClick={onLayout}
            title={isPdf ? t("pdf.options") : t("reader.layout")}
          >
            <span className="rc-btn-ico"><span className="ico-cols"><span /><span /></span></span>
            <span className="rc-btn-label">{isPdf ? t("pdf.options") : t("reader.layout")}</span>
          </button>
          {/* Bookmark + Notes are CFI-based — unavailable for a PDF in Phase 0 (RAWY-85). */}
          {!isPdf && (
            <button
              className={`rc-btn${bookmarked ? " on" : ""}`}
              onClick={onBookmark}
              title={bookmarked ? t("bookmark.remove") : t("bookmark.add")}
            >
              <span className="rc-btn-ico"><span className="ico-ribbon" /></span>
              <span className="rc-btn-label">{t("reader.bookmark")}</span>
            </button>
          )}
          {!isPdf && <span className="rc-divider" aria-hidden />}
          {!isPdf && (
            <button className={`rc-btn${annoOpen ? " on" : ""}`} onClick={onAnnotations} title={t("reader.notes")}>
              <span className="rc-btn-ico"><span className="ico-note" /></span>
              <span className="rc-btn-label">{t("reader.notes")}</span>
            </button>
          )}
          {/* Photo-card Quotes collection (RAWY-60; user-facing name "Quotes"/"اقتباسات" RAWY-66,
              internal "basket" names kept) — hidden when empty, so normal reading stays clean. */}
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

      {/* RAWY-113: while the read-aloud bar is docked at the bottom, it replaces the reading-progress
          bar (it carries the chapter + position + a progress hairline of its own). */}
      <div className={`rc-bottom${ttsActive ? " rc-bottom-hidden" : ""}`}>
        <div className="rc-meta">
          {/* PDF: a page position (no chapters); EPUB: the chapter label — RAWY-87 */}
          <span dir="auto">
            {isPdf && pdfPageCount
              ? t("pdf.pageOf", { n: localeNum(pdfPage, lang), total: localeNum(pdfPageCount, lang) })
              : chapter}
          </span>
          <span>{localeNum(pct, lang)}%</span>
        </div>
        <div
          className={`rc-progress${isPdf ? " rc-progress-scrub" : ""}${scrub != null ? " scrubbing" : ""}`}
          ref={trackRef}
          {...(isPdf ? { onPointerDown: scrubDown, onPointerMove: scrubMove, onPointerUp: scrubUp } : {})}
        >
          <div className="rc-progress-fill" style={{ width: `${pct}%` }} />
          <div className="rc-progress-knob" style={{ left: `${pct}%` }} />
        </div>
      </div>
    </div>
  );
}
