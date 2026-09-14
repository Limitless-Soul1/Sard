import { useRef, useState } from "react";

import { Icon } from "../../components/Icon";
import { useI18n } from "../../i18n";
import { displayTitle } from "../../lib/bookMeta"; // WP-3: one rule for a missing title
import { localeNum } from "../../lib/format";
import { releaseButtonFocusAfterPointerClick } from "../../lib/tts";
import type { PositionReadout } from "../../reader-engine/position"; // WP-4F

// RAWY-216: the settings drawer is grouped by CONCEPT, not by which tab got built first. Five tabs;
// the toolbar's three shortcut buttons (Aa / theme / layout) still land on the three most-used ones,
// and the drawer's tab bar reaches all five (Read-aloud + All books included).
export type SettingsSection = "typography" | "layout" | "colour" | "readaloud" | "allbooks";

interface Props {
  visible: boolean;
  /** WP-4F: the resolved position readout, or null when the book reports no usable position. */
  position: PositionReadout | null;
  bookTitle: string | null;
  chapter: string;
  fraction: number;
  onBack: () => void;
  onContents: () => void;
  onSearch: () => void; // RAWY-88: in-book search (EPUB only)
  searchOpen: boolean;
  onListen: () => void; // RAWY-105: read-aloud / TTS (EPUB only)
  ttsActive: boolean;
  /** The reader's one settings entrance — see the button below. */
  onSettings: () => void;
  onAnnotations: () => void;
  onBookmark: () => void;
  bookmarked: boolean;
  chaptersOpen: boolean;
  annoOpen: boolean;
  settingsOpen: boolean;
  // Photo-card Quotes collection (RAWY-60; user-facing "Quotes"/"اقتباسات" — RAWY-66): appears
  // only when non-empty; the badge shows the count; it sits in this pinned cluster (physical
  // side, D21) and opens the passages tray.
  basketCount: number;
  basketOpen: boolean;
  onBasket: () => void;
  isPdf?: boolean; // RAWY-85: a PDF is read-only — hide the EPUB-only controls
  // RAWY-293: read-aloud IS offered for a PDF, but only when the open document actually yields
  // speakable text. Gated on real extraction, never on the format alone.
  pdfCanListen?: boolean;
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
  position,
  bookTitle,
  chapter,
  fraction,
  onBack,
  onContents,
  onSearch,
  searchOpen,
  onListen,
  ttsActive,
  onSettings,
  onAnnotations,
  onBookmark,
  bookmarked,
  chaptersOpen,
  annoOpen,
  settingsOpen,
  basketCount,
  basketOpen,
  onBasket,
  isPdf,
  pdfCanListen,
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
    // RAWY-288: DELIBERATELY NOT `inert`, unlike the five closed panels. RAWY-194 gives a keyboard user
    // their only route to the auto-hidden toolbar: Tab INTO it reveals and pins it (the `focusin` +
    // `:focus-visible` handler in Reader). Marking it inert would remove the chrome from the tab order
    // and delete that affordance outright — a worse accessibility outcome than the transient
    // aria-hidden mismatch it would fix. That mismatch lasts one tick: focus lands, the handler fires,
    // and `visible` flips true.
    <div className={`reader-chrome${visible ? " show" : ""}`} aria-hidden={!visible}>
      <div className="rc-top">
        {/* LEFT: the controls whose panels dock on the physical left, then the book/chapter context.
            Contents and Search are here because `READER_PANEL_SIDE` says their panels are here —
            RAWY-32's rule is that a panel sits on the same physical side as the button that opens
            it, and these two were the only controls that broke it. The bar previously had one
            control group, pinned right, so there was nowhere else for them to go; giving it the
            second group is the whole fix. See `panelSides.ts`.

            RAWY-230 (§4) applies to this group exactly as it does to the right one: blur a button
            after a POINTER click so it cannot keep DOM focus and swallow the next SPACE/arrow. It
            is the container's handler, so a group without it would silently lose the behaviour. */}
        <div className="rc-nav">
          {/* ONE CLUSTER, BUILT LIKE THE RIGHT-HAND ONE: parts held apart by an `.rc-divider`.
              Leaving the book on one side of it, looking into the book on the other — the same shape
              the trailing cluster uses to hold Notes apart from the appearance tools. Back sitting
              inside the group also puts it under RAWY-230's pointer-blur.

              THE CHEVRON IS A DRAWING, NOT A CHARACTER. It used to be the text glyph «‹», and a
              glyph cannot be centred by centring its box: a font gives it asymmetric side bearings
              and positions it on a baseline inside a line box taller than the mark itself, so the
              INK sat left of and above the middle however the box was aligned. Every other icon on
              this bar is drawn; this one now is too, on the same 24-unit grid at the same stroke, and
              its path is symmetric about the grid's centre — apex at x=9, arms ending at x=15, so
              9..15 centres on 12, and 6..18 centres on 12 vertically. Round caps add the same 1 unit
              to all four sides and cannot move it. It is centred by geometry, with nothing to nudge,
              and it never mirrors: the chrome is pinned and so is this. */}
          <div className="rc-btns" onClickCapture={releaseButtonFocusAfterPointerClick}>
            <button className="rc-btn rc-back" onClick={onBack} title={t("reader.back")}>
              <span className="rc-btn-ico">
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M15 6 L9 12 L15 18" /></svg>
              </span>
              <span className="rc-btn-label">{t("reader.back")}</span>
            </button>
            <span className="rc-divider" aria-hidden />
            <button className={`rc-btn${chaptersOpen ? " on" : ""}`} onClick={onContents} title={t("reader.contents")}>
              <span className="rc-btn-ico"><span className="ico-lines"><span /><span /><span /></span></span>
              <span className="rc-btn-label">{t("reader.contents")}</span>
            </button>
            {/* RAWY-88 put Search immediately after Contents — the two "find your way" tools kept
                together — and they still are, now on the edge they both open onto. EPUB-only; a PDF
                keeps its own RAWY-86 find. */}
            {!isPdf && (
              <button className={`rc-btn${searchOpen ? " on" : ""}`} onClick={onSearch} title={t("search.title")}>
                <span className="rc-btn-ico">
                  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg>
                </span>
                <span className="rc-btn-label">{t("search.title")}</span>
              </button>
            )}
          </div>
        </div>

        {/* CENTRE: what is being read. It is the one thing here that is not a control, and it is no
            longer inside the navigation zone — being there is what crowded that edge and left the
            middle of the bar empty. The reading chrome's other bar already reads as three parts
            (chapter · position · percent), so the top bar now matches it: controls at each edge,
            identity between them. */}
        <div className="rc-title-block">
          <span className="rc-book" dir="auto">{displayTitle({ title: bookTitle }, t)}</span>
          <span className="rc-chapter" dir="auto">{chapter}</span>
        </div>

        {/* RIGHT: the controls whose panels dock on the physical right — Notes, and the settings
            slide-over the three appearance buttons open. Unchanged, and unchanged deliberately:
            these already satisfied RAWY-32's rule, so nothing here needed to move.
            RAWY-230 (§4): blur a button after a POINTER click (RAWY-194's helper, detail>0 only) so it
            doesn't keep DOM focus and swallow the next SPACE/arrow (which would re-activate the button /
            re-open its panel). Keyboard focus (:focus-visible / Tab) is preserved — blur skips detail===0. */}
        <div className="rc-btns" onClickCapture={releaseButtonFocusAfterPointerClick}>
          {/* THE COLLECTION LEADS THE TOOLS. Gathering a passage is part of reading rather
              than a tool reached for once the reading is done, so it sits at the head of this
              cluster instead of at the end of it. */}
          {basketCount > 0 && (
            <button
              className={`rc-btn rc-basket${basketOpen ? " on" : ""}`}
              onClick={onBasket}
              title={t("basket.title")}
              aria-expanded={basketOpen}
            >
              <span className="rc-btn-ico">
                <BasketIco />
              </span>
              {/* THE COUNT SITS INSIDE THE CONTROL. It was a badge pinned at -8px above the icon's
                  outer corner, which put it over the top edge of a bar that begins at the top edge
                  of the window - photographed half cut off at four passages. Nothing here is
                  positioned out of flow, so there is no count at which it can leave the button. */}
              <span className="rc-btn-label rc-basket-label">
                <span>{t("photo.basket")}</span>
                <span className="rc-basket-n">{localeNum(basketCount, lang)}</span>
              </span>
            </button>
          )}
          {/* RAWY-105 / RAWY-293: Listen. For a PDF this appears once the text layer proves usable —
              a scan yields nothing to speak, so offering the control there would be a dead button. */}
          {(!isPdf || pdfCanListen) && (
            <button className={`rc-btn${ttsActive ? " on" : ""}`} onClick={onListen} title={t("tts.listen")}>
              <span className="rc-btn-ico">
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M4 10v4M8 7v10M12 4v16M16 8v8M20 11v2" /></svg>
              </span>
              <span className="rc-btn-label">{t("tts.listen")}</span>
            </button>
          )}
          {/* ONE DOOR, NOT THREE.
              The bar carried «النص», «الألوان» and «التخطيط» side by side, and all three opened the
              SAME drawer — three buttons whose only difference was which of its tabs was showing.
              That is a tab strip rendered twice: once in the toolbar and once inside the panel it
              opens, with the toolbar copy taking three of the bar's slots to say what the panel says
              better. The drawer keeps every one of its sections; only its ENTRANCE is single now.

              It opens on «الألوان» because colour is the setting a reader reaches for most often
              while actually reading — the light in the room changed, not the typography. Every other
              section is one tab away, and the drawer remembers where it was left.

              The label is `reader.settings`, which is the name the panel already gives ITSELF in its
              own header, so the button and the surface it opens finally agree on what they are.

              A PDF is read-only, so its drawer is a different panel (direction + honest limits) and
              names itself `pdf.options`; the button follows that name rather than promising settings
              a fixed-layout document does not have. */}
          <button
            className={`rc-btn${settingsOpen ? " on" : ""}`}
            onClick={onSettings}
            title={isPdf ? t("pdf.options") : t("reader.settings")}
          >
            {/* AT THE BAR'S OWN SIZE AND WEIGHT. `size="sm"` is 14px, and every other mark on this bar is
                drawn at 17 with a 1.9 stroke — so the settings gear arrived smaller and lighter than
                its neighbours on the one control that should read first. 18 rather than 17 because a
                gear's silhouette is a circle, and a circle reads a shade smaller than the squarer
                marks beside it at the same box. The small artwork is what makes that size legible;
                see `SMALL.gear` in the icon set. */}
              <span className="rc-btn-ico"><Icon name="gear" size="sm" width={18} height={18} strokeWidth={1.9} /></span>
            <span className="rc-btn-label">{isPdf ? t("pdf.options") : t("reader.settings")}</span>
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
          {/* THE SURFACE, NAMED AND DRAWN AS ITSELF.
              It was labelled «ملاحظات» and wore an empty bordered square. The label named one of
              the five things behind it, and the square drew none of them. Both are answered from
              what Sard already has: `panel.annoEyebrow` is the name this very panel gives itself in
              its own eyebrow — so the button and the surface finally agree — and
              `navHighlightsNotes` is the mark the library's archive already wears for the same
              idea, described in the icon set as "the editor's mark for these belong together".
              A margin bracket is exactly the mark that gathers a set, which is what this is. */}
          {!isPdf && (
            <button className={`rc-btn${annoOpen ? " on" : ""}`} onClick={onAnnotations} title={t("panel.annoEyebrow")}>
              <span className="rc-btn-ico"><Icon name="navHighlightsNotes" size="md" /></span>
              <span className="rc-btn-label">{t("panel.annoEyebrow")}</span>
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
          {/* RESILIENCE-1 / WP-4F: the position readout the reader asked for. A PDF already shows a
              real page count above, so this is the reflowable case only. Absent (not zero, not a
              guess) when the book gives foliate nothing to report — see reader-engine/position.ts. */}
          {!isPdf && position && (
            <span className="rc-pos" dir="auto">
              {position.total
                ? t(position.labelKey, { n: position.current, t: position.total })
                : t(position.labelKey, { n: position.current })}
            </span>
          )}
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
