// Chapters / TOC panel (RAWY-21, band C-II). A leading-side slide-in panel listing the
// book's table of contents (from foliate). The current chapter is marked; clicking a row
// jumps via the entry's href (CFI-equivalent navigation). When "Hide chapter titles" is on
// (the RAWY-13 anti-spoiler setting) it shows neutral "Chapter N" labels instead of titles.
// Placement + content follow the UI direction (RAWY-30) — chapters sits on the UI-leading
// edge, the same side as the toolbar "contents" button. Book-derived chapter titles use
// dir="auto" so Arabic titles still render RTL inside an LTR UI (and vice-versa).

import { memo, useEffect, useMemo, useRef } from "react";

import { useI18n } from "../../i18n";
import type { ReadMarkerKey } from "../../lib/readMarkerStyle"; // RAWY-256
import { extractChapterNumber, localeNum } from "../../lib/format";
import type { TocEntry } from "../../reader-engine/FoliateController";
// The dock side is DECLARED, not spelled here: `panelSides.ts` is the one place that says which
// physical edge this panel uses, and the toolbar groups its control from the same entry (RAWY-32).
import { panelDockClass } from "./panelSides";
import { offerReturn } from "./furthestRead";
import { FurthestReturn } from "./FurthestReturn";

// RAWY-175 (AUD-3): one TOC row, MEMOIZED. On a chapter change only the two rows whose `active` flips
// re-render — the other ~1,300 rows are skipped (their props are unchanged) instead of re-reconciling
// the whole list on every parent re-render. Renders + navigates + highlights EXACTLY as before; the
// per-row `extractChapterNumber`/`localeNum` now run only when a row actually renders. `onJump` must be
// a stable reference (the parent passes a memoized fn) for the skip to hold.
const TocRow = memo(function TocRow({
  entry,
  index,
  num,
  active,
  read,
  hideTitles,
  onJump,
}: {
  entry: TocEntry;
  index: number;
  /** RAWY-287: the number to display, decided ONCE for the whole book (see `bookNumbers`).
   *  `null` = this entry has no chapter designator in a book that numbers its chapters. */
  num: number | null;
  active: boolean;
  /** RAWY-256: chapter read to the end (completion rule + storage are RAWY-250 / D66 — consumed, not
   *  recomputed). Drives the `.read` class; the six variants are pure CSS on this row, no extra DOM. */
  read: boolean;
  hideTitles: boolean;
  onJump: (href: string) => void;
}) {
  const { t, lang } = useI18n();
  // RAWY-287: ONE numbering source per book — see `bookNumbers` in the panel below. `num` is either
  // the book's OWN designator or a positional fallback, never a mixture of the two in one list, and
  // `null` means "this entry carries no chapter number and the book numbers its chapters itself"
  // (front matter, Contents, a preface). Such a row is labelled as a SECTION, not as a chapter,
  // because calling it "Chapter 3" is what made a Contents page outrank the real Chapter I.
  const chapterLabel = num == null
    ? t("panel.tocSection", { n: localeNum(index + 1, lang) })
    : t("panel.chapter", { n: localeNum(num, lang) });
  const label = hideTitles ? null : entry.label || chapterLabel;
  return (
    <button
      className={`rp-row toc-row${active ? " active" : ""}${read ? " read" : ""}`}
      style={{ paddingInlineStart: 11 + entry.level * 14 }}
      onClick={() => entry.href && onJump(entry.href)}
      disabled={!entry.href}
    >
      {hideTitles ? (
        <span className="toc-num big" dir="auto">{chapterLabel}</span>
      ) : (
        <span className="toc-num">{localeNum(num ?? index + 1, lang)}</span>
      )}
      {label && (
        <span className="toc-label" dir="auto">
          {label}
        </span>
      )}
      <span className={`toc-dot${active ? " current" : ""}`} />
    </button>
  );
});

interface Props {
  open: boolean;
  onClose: () => void;
  toc: TocEntry[];
  /** WP-6A: null when these are the BOOK's contents; otherwise how Sard built them. */
  synthesised?: boolean;
  currentHref: string | null;
  /** RAWY-287: the TOC row the reader is currently inside, resolved by the Reader against EPUB
   *  reading order (see `tocIndex` there). `-1` = genuinely outside every listed entry.
   *  Supersedes matching `currentHref` here, which could not represent either of the two cases
   *  a valid EPUB routinely produces: a spine document with NO nav entry, and several nav entries
   *  inside ONE document. */
  activeIndex: number;
  /** RAWY-256: TOC hrefs whose chapter is read — a STABLE Set (memoised in Reader), never rebuilt per row. */
  readHrefs: Set<string>;
  /** RAWY-256: the global variant choice; scopes the CSS for all six on the list container. */
  readMarker: ReadMarkerKey;
  // Still needed here AFTER RAWY-216 removed this panel's toggle: the TOC rows render the
  // "الفصل N"/"Chapter N" placeholder instead of the real title while it is on (RAWY-69/70).
  hideTitles: boolean;
  onJump: (href: string) => void;
  fraction: number;
  /** The contents entry holding the furthest point the reader has reached, or null when unknown. */
  furthestHref?: string | null;
  /** Offer the way back to it? False whenever the reader is already at or beyond it. */
  furthestOffered?: boolean;
  onGoFurthest?: () => void;
}

// RAWY-175 (AUD-3): MEMOIZED so an unrelated Reader re-render (a search-results batch ~every 90 ms, a
// TTS word tick) does NOT re-reconcile the ~1,300-row list. It re-renders only when its own props
// change (toc, currentHref, hideTitles, fraction, …) — which requires the parent to pass STABLE
// callback references (Reader wraps them in useCallback). Behaviour is identical; only the wasted
// re-renders are removed (PERF-01: this was ~5 ms of every search commit).
function ChaptersPanelInner({
  open,
  onClose,
  toc,
  currentHref,
  activeIndex,
  readHrefs,
  readMarker,
  hideTitles,
  onJump,
  fraction,
  synthesised = false,
  furthestHref = null,
  furthestOffered = false,
  onGoFurthest,
}: Props) {
  const { t, lang, dir } = useI18n();
  const pct = Math.round(fraction * 100);

  // RAWY-103: when the panel opens (or the current chapter / TOC becomes known while it's open),
  // scroll the list so the ACTIVE chapter is centred in view. Without this the list always sits at
  // chapter 1, so in a long book (1300+ chapters) the current chapter — though highlighted — is far
  // off-screen and the reader has to hunt for it. All rows are rendered (not virtualised), so the
  // active row exists in the DOM; we set the container's scrollTop directly (vertical scroll is
  // direction-agnostic, so this works identically in LTR and RTL). Instant (not smooth) so opening a
  // huge book lands on the current chapter at once instead of animating past hundreds of rows.
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const scrollEl = scrollRef.current;
    if (!scrollEl) return;
    const raf = requestAnimationFrame(() => {
      const activeEl = scrollEl.querySelector<HTMLElement>(".toc-row.active");
      if (!activeEl) return; // no current chapter (e.g. empty/unmatched TOC) → leave at the top
      const cRect = scrollEl.getBoundingClientRect();
      const aRect = activeEl.getBoundingClientRect();
      // centre the active row within the scroll viewport (clamped by the browser at the ends)
      scrollEl.scrollTop += aRect.top - cRect.top - (scrollEl.clientHeight - aRect.height) / 2;
    });
    return () => cancelAnimationFrame(raf);
  }, [open, currentHref, toc]);

  // RAWY-287 — ONE NUMBERING SOURCE PER BOOK, decided from the TOC itself.
  //
  // The defect was not only that numbers were scraped from prose; it was that TWO sources were mixed
  // in one list. Rows whose label carried a designator showed the BOOK's number, rows without showed
  // their POSITION, and the two collide as soon as a book has front matter: measured on a real EPUB,
  // "Contents" (position 3) and an edition line (scraped 3) both rendered "Chapter 3", while the
  // book's actual Chapter I rendered "Chapter 4" and no row rendered "Chapter 2" at all.
  //
  // A book either numbers its own chapters or it does not, so pick one source for the whole list:
  //   • two or more entries carry a designator  -> the book numbers itself. Use ITS numbers, and mark
  //     the remaining entries as unnumbered sections rather than inventing chapter numbers for them.
  //   • otherwise -> no numbering to honour; fall back to TOC position for every row, exactly as
  //     before. This is the common case (an Arabic novel whose entries are plain titles) and it keeps
  //     those books rendering identically to the previous build.
  // Collisions are impossible by construction: within one book the two sources are never mixed.
  //
  // RESILIENCE-1 — the "two designators" bar was far too low, and it was MEASURED, not reasoned:
  // `extractChapterNumber` matched 25 of 264 entries in one reported book (9.5 %), which was enough
  // to select OWN and leave the other 239 rows unnumbered — every one of them rendering "Section N".
  // Worse, the 25 matches were WRONG: labels read "المجلد 12 الفصل 214 : …", so the extractor took
  // the VOLUME (12), not the chapter (214), and rows 215/216 both resolved to 12 — the very
  // collision RAWY-287 exists to prevent, reintroduced through the back door.
  //
  // The invariant RAWY-287 states is "a book either numbers its chapters or it does not", and a
  // 9.5 % hit rate is noise, not a numbering scheme. So the test is now PROPORTIONAL, with the
  // threshold taken from the corpus rather than invented — measured match rates:
  //
  //     numbers itself : LotM 100 % · halaqat 100 % · red-rising 83 % · Alice 71 %
  //     does not       : metamorphosis 40 % · reported-book 9.5 % · ad-daa 3 % · shawqiyyat 1 %
  //
  // Nothing lies between 40 % and 71 %, so a half majority separates them with room on both sides.
  // The original "two, not one" guard is KEPT as well, so a one-entry TOC cannot reach OWN at 100 %.
  // Four books keep OWN exactly as before; three move to positional and every one is a repair
  // (ad-daa alone had 110 of 113 rows mislabelled).
  const bookNumbers = useMemo(() => {
    const own = toc.map((c) => extractChapterNumber(c.label));
    const matched = own.filter((n) => n != null).length;
    const numbersItself = matched >= 2 && matched / own.length >= 0.5;
    return numbersItself ? own : toc.map((_, i) => i + 1);
  }, [toc]);

  // THE FURTHEST POINT, NAMED THE WAY THIS LIST NAMES EVERYTHING ELSE.
  //
  // The mark itself is a cfi and knows nothing about chapter numbers — deliberately, because numbering
  // is this panel's decision and it is made once per book (`bookNumbers` above). So the mark arrives as
  // an href, is looked up as one of these rows, and is named by the same two lines every row uses. Two
  // consequences worth stating: the number shown here can never disagree with the number shown on the
  // row it points at, and while chapter titles are hidden this shows the neutral "الفصل N" like the
  // rest of the list — a control that leaked the title of a chapter you have not read yet would defeat
  // the setting it sits above.
  const furthest = useMemo(() => {
    if (!furthestOffered || !furthestHref) return null;
    const i = toc.findIndex((c) => c.href === furthestHref);
    if (i < 0) return null; // the contents changed under an old mark — say nothing rather than guess
    // Already in the chapter you got to (or past it)? Then there is nothing to return to.
    if (!offerReturn(i, activeIndex)) return null;
    const num = bookNumbers[i];
    const name =
      num == null
        ? t("panel.tocSection", { n: localeNum(i + 1, lang) })
        : t("panel.chapter", { n: localeNum(num, lang) });
    // EXACTLY WHAT THE ROW SAYS, and nothing beside it. Naming the chapter twice — the computed
    // "Chapter 10" next to a title that already reads "CHAPTER X. The Lobster Quadrille" — was how the
    // first build read, and in a book whose entries carry their own numbers (the 1,000-chapter case
    // this feature is for) it says the number twice in a row. The row's own rule is one line long and
    // is the right one: the book's title when there is one, the computed name when there is not, and
    // the computed name alone while titles are hidden.
    return { name: hideTitles ? name : toc[i].label || name };
  }, [furthestOffered, furthestHref, activeIndex, toc, bookNumbers, hideTitles, t, lang]);

  return (
    // RAWY-288: `inert` alongside `aria-hidden`. The panel stays MOUNTED when closed (that is what keeps
    // the ~1,400-row TOC instant to reopen) and is only moved off-screen by transform — so every row
    // stayed in the tab order while being announced as hidden. Measured over a 160-press Tab cycle: 67
    // stops (42%) landed on controls inside `aria-hidden` closed panels. `inert` is the standard
    // primitive that removes a subtree from BOTH the tab order and the a11y tree, so the two can no
    // longer disagree; no per-control tabIndex bookkeeping, and nothing to undo when the panel opens.
    <aside className={`reader-panel ${panelDockClass("contents")}${open ? " show" : ""}`} dir={dir} aria-hidden={!open} inert={!open}>
      {/* header (RAWY-33; RAWY-36): title + chapter/percent meta + close. */}
      <div className="rp-head">
        <div className="rp-head-titles">
          <span className="rp-title">{t("panel.contents")}</span>
          <span className="rp-submeta">
            {t("panel.chaptersMeta", { n: localeNum(toc.length, lang), p: localeNum(pct, lang) })}
          </span>
          {/* RESILIENCE-1 / WP-6A: NEVER present a guess as the book's own. This book shipped a
              contents list too small to navigate by, so Sard built one from the spine — and says so
              quietly, once, in the header rather than on every row. */}
          {synthesised && <span className="rp-synth-note">{t("panel.contentsSynthesised")}</span>}
        </div>
        <div className="rp-head-actions">
          <button className="rp-x ui-close" onClick={onClose} title={t("panel.close")} aria-label={t("panel.close")}>✕</button>
        </div>
      </div>

      {/* RAWY-216: the two anti-spoiler toggles (RAWY-69) used to be duplicated HERE and in the settings
          drawer — the same two global flags, same state, two places, worded differently. They now live
          ONLY in the drawer's "All books" tab, which is also their honest scope label. `hideTitles` is
          still a PROP because the TOC rows below render the "الفصل N"/"Chapter N" placeholder from it. */}

      {/* THE WAY BACK TO THE FURTHEST POINT REACHED.
          It lives here — between the header and the list — because this panel IS chapter navigation: a
          reader who left chapter 488 for 320 left through this list and comes back through it, so the
          way back belongs where the way out was, not as another button in the reader's chrome.
          Outside the scroller on purpose: nothing to make sticky, nothing to paint an opaque ground
          for, and the rows below it never slide under it.
          It renders ONLY when there is a point to return to and the reader is behind it — at the
          furthest point (where a resumed book normally opens) the panel looks exactly as it always
          has. */}
      {furthest && onGoFurthest && <FurthestReturn label={furthest.name} onGo={onGoFurthest} />}

      {/* RAWY-256: the chosen variant scopes the marker CSS for the whole list (one class, not per row),
          so switching variants costs a single attribute change even on a 1432-row panel. */}
      <div className={`rp-scroll rm-${readMarker}`} ref={scrollRef}>
        {toc.length === 0 && <div className="rp-empty">{t("panel.noChapters")}</div>}
        {/* RAWY-175: each row is a memoized <TocRow> (see top of file). The book's OWN chapter number
            (RAWY-67), the "الفصل N"/"Chapter N" hidden-titles label (RAWY-69/70), the active highlight,
            paddingInlineStart-by-level, and the click-to-navigate all live in TocRow — unchanged; only
            unchanged rows now skip re-rendering. All rows stay in the DOM, so RAWY-103 scroll-to-active
            and click-to-any-chapter work identically. */}
        {toc.map((c, i) => (
          <TocRow
            key={`${c.href ?? "x"}-${i}`}
            entry={c}
            index={i}
            num={bookNumbers[i]}
            active={i === activeIndex}
            read={!!c.href && readHrefs.has(c.href)}
            hideTitles={hideTitles}
            onJump={onJump}
          />
        ))}
      </div>
    </aside>
  );
}

export const ChaptersPanel = memo(ChaptersPanelInner);
