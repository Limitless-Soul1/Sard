// In-book search panel (RAWY-88, Plan Phase 7) — built from docs/design/In-Book Search (standalone).html.
// A leading-side (physical-left, like Contents — RAWY-32/D21) slide-in: an input that searches the
// CURRENT book (foliate's whole-book search), a results list (chapter · location + a snippet with the
// match bolded), a match count, jump-to-result, and the marquee SPOILER-SAFE toggle (on by default):
// matches BEYOND the reader's furthest-read position collapse into ONE sealed card — a count, never a
// snippet. The panel chrome is APP furniture (UI language + pinned side); the snippets are BOOK text
// (they follow the book's own face + direction), exactly like the page.

import { memo, useEffect, useRef, useState } from "react";

import { useI18n } from "../../i18n";
import { localeNum } from "../../lib/format";
import { displayTitle } from "../../lib/bookMeta"; // WP-3: one rule for a missing title
import type { SearchHit } from "../../reader-engine/FoliateController";
import { FurthestReturn } from "./FurthestReturn";

import { isArabicText } from "../../lib/typography";
// The dock side is DECLARED, not spelled here: `panelSides.ts` is the one place that says which
// physical edge this panel uses, and the toolbar groups its control from the same entry (RAWY-32).
import { panelDockClass } from "./panelSides";
interface Props {
  open: boolean;
  onClose: () => void;
  bookTitle: string | null;
  /** What the spoiler-safe boundary is CALLED — always the reader's own current chapter, because that
   *  is always what the boundary IS. Nothing about the furthest-read mark reaches these strings. */
  positionLabel: string;
  /** Is the reader behind the deepest point they have reached? The only thing that depends on it is
   *  whether the way back is offered — never what is searched, and never what is hidden. */
  behindFurthest?: boolean;
  /** What that deepest point is called, for the control that offers the way back to it. */
  furthestLabel?: string | null;
  /** Take the reader back to the furthest point they have read. Absent for a PDF or with no mark. */
  onGoFurthest?: () => void;
  /** Move the furthest-read mark to where the reader is standing, without moving the reader. */
  onResetFurthest?: () => void;
  bookDir: "rtl" | "ltr"; // the BOOK's direction — snippets follow it (not the UI)
  query: string;
  onQuery: (q: string) => void;
  searching: boolean;
  searchProgress: number; // RAWY-89: scan fraction (0..1) for the live in-progress indicator
  hits: SearchHit[];
  spoilerSafe: boolean;
  onToggleSpoiler: () => void;
  /** WHICH WAY THE BOOK IS READ BY THE SEARCH. Off = first section to last, as it always was. On =
   *  from where the reader is standing, back to the beginning. Nothing to do with the furthest-read
   *  control below it: that one is about reading progress and offers the way back to it. */
  backward: boolean;
  onToggleBackward: () => void;
  /** Whole-word matching: the query must stand as a word, not sit inside a longer one. OFF by default. */
  wholeWord: boolean;
  onToggleWholeWord: () => void;
  revealAhead: boolean; // "show them anyway" — reveal ahead matches this once (spoiler stays on)
  onRevealAhead: (v: boolean) => void;
  activeCfi: string | null;
  onJump: (hit: SearchHit) => void;
}

// One result row: chapter · location badge, then the snippet with the match in gold. RAWY-175 (AUD-3):
// MEMOIZED so a streaming batch (~every 90 ms) only renders the NEW rows, not every existing one — the
// row skips when its props are unchanged. `onJump` takes the hit and MUST be a stable reference (the
// panel passes the parent's memoized handler), so `active` (the only per-row flag that flips on a jump)
// is what triggers a re-render. Snippet, badge, highlight, RTL, click-to-navigate — all identical.
const ResultRow = memo(function ResultRow({
  hit, active, ahead, onJump, bookDir, lang, aheadLabel,
}: {
  hit: SearchHit; active: boolean; ahead: boolean; onJump: (hit: SearchHit) => void;
  bookDir: "rtl" | "ltr"; lang: string; aheadLabel: string;
}) {
  return (
    <button className={`sr-row${active ? " active" : ""}${ahead ? " ahead" : ""}`} onClick={() => onJump(hit)}>
      <span className="sr-meta">
        <span className="sr-chapter" dir="auto">{hit.chapterLabel}</span>
        {ahead && <span className="sr-ahead-tag">{aheadLabel}</span>}
        <span className="sr-loc">٪{localeNum(Math.round(hit.frac * 100), lang)}</span>
      </span>
      {/* A snippet is the BOOK'S words, so its script decides its face — Amiri for Arabic, as
          everywhere else in Sard. `isArabicText` is the one script rule, in lib/typography.ts. */}
      <span className={`sr-snippet${isArabicText(`${hit.pre}${hit.match}${hit.post}`) ? " ar" : ""}`} dir={bookDir}>
        {hit.pre}
        <mark className="sr-hit">{hit.match}</mark>
        {hit.post}
      </span>
    </button>
  );
});

export function SearchPanel({
  open, onClose, bookTitle, positionLabel, behindFurthest = false, furthestLabel = null,
  onGoFurthest, onResetFurthest, bookDir,
  query, onQuery, searching, searchProgress, hits,
  spoilerSafe, onToggleSpoiler, wholeWord, onToggleWholeWord, backward, onToggleBackward, revealAhead, onRevealAhead,
  activeCfi, onJump,
}: Props) {
  const { t, lang, dir } = useI18n();
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus the input whenever the panel opens (so ⌘F / the button land ready to type).
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  // MEASURED AND LEFT ALONE. Splitting the list in one memoised pass instead of two filters per render
  // was tried against 15,481 matches in a real book: 393ms blocked without it, 404ms with it — no
  // difference outside the noise, because the quadratic de-duplication in the engine was the whole
  // cost and these two passes never were. Kept as it was rather than carrying a memo that buys nothing.
  const upTo = hits.filter((h) => !h.ahead);
  const ahead = hits.filter((h) => h.ahead);
  const reveal = !spoilerSafe || revealAhead; // show the ahead snippets?
  const q = query.trim();

  // RAWY-175 (AUD-3): render only the first `renderLimit` result rows and grow the window as the user
  // scrolls toward the bottom. A common token yields thousands of hits; rendering them all made every
  // ~90 ms streaming batch re-reconcile the whole (growing) list — PERF-01's ~26 ms/commit. Every hit
  // stays in `hits` and becomes visible by scrolling (nothing dropped); the count / boundary / sealed
  // card below still use the FULL arrays, so the numbers are unchanged. Reset when the query changes.
  const RENDER_STEP = 60;
  const [renderLimit, setRenderLimit] = useState(RENDER_STEP);
  useEffect(() => { setRenderLimit(RENDER_STEP); }, [query]);
  const resultsRef = useRef<HTMLDivElement>(null);
  const onResultsScroll = () => {
    const el = resultsRef.current;
    if (el && el.scrollTop + el.clientHeight >= el.scrollHeight - 500) setRenderLimit((l) => l + RENDER_STEP);
  };
  const shownUpTo = upTo.slice(0, renderLimit);
  const allUpToShown = shownUpTo.length >= upTo.length;
  const shownAhead = allUpToShown && reveal ? ahead.slice(0, Math.max(0, renderLimit - upTo.length)) : [];
  // every result row is on screen → the footer chrome (sealed card / hide-again / tashkīl note) sits at
  // the true bottom (for small searches this is true immediately, so behaviour is unchanged).
  const allShown = allUpToShown && (!reveal || shownAhead.length >= ahead.length);

  return (
    // RAWY-288: see ChaptersPanel — `inert` keeps the closed panel out of the tab order.
    <aside className={`reader-panel ${panelDockClass("search")} search-panel${open ? " show" : ""}`} dir={dir} aria-hidden={!open} inert={!open}>
      <div className="rp-head">
        <div className="rp-head-titles">
          <span className="rp-title">{t("search.title")}</span>
          <span className="rp-submeta" dir="auto">{displayTitle({ title: bookTitle }, t)}</span>
        </div>
        <div className="rp-head-actions">
          <button className="rp-x ui-close" onClick={onClose} title={t("panel.close")} aria-label={t("panel.close")}>✕</button>
        </div>
      </div>

      {/* search input */}
      <div className="sp-search-field">
        <span className="sp-search-ico" aria-hidden>
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg>
        </span>
        <input
          ref={inputRef}
          className="sp-search-input"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          placeholder={t("search.placeholder")}
          dir="auto"
          spellCheck={false}
        />
        {query && <button className="sp-search-clear" onClick={() => onQuery("")} aria-label="✕">✕</button>}
      </div>

      {/* WHOLE WORD — a matching option, so it sits directly under the field it changes and above the
          spoiler switch, which is about what is SHOWN rather than what is found. The same row the
          spoiler toggle uses, so the panel keeps one shape for its two switches; `sp-opt` only tightens
          it, because this one says its whole piece in a single short line. App furniture: it follows the
          interface language and direction, never the book's. */}
      <button className="sp-spoiler sp-opt" onClick={onToggleWholeWord} aria-pressed={wholeWord}>
        <span className="sp-spoiler-text">
          <span className="sp-spoiler-label">{t("search.wholeWord")}</span>
          <span className="sp-spoiler-sub">{t("search.wholeWordSub")}</span>
        </span>
        <span className={`rp-switch${wholeWord ? " on" : ""}`} aria-hidden><span className="rp-knob" /></span>
      </button>

      {/* WHICH WAY THE SEARCH READS. The third of the panel's switches, in the shape the other two
          already have — a labelled row with the same `rp-switch` — rather than a new kind of control
          for a two-way choice the panel can already express.

          It is NOT the furthest-read control further down, and the two must not be read as one: that
          one is reading progress (how deep this reader has been, and the way back to it), this one is
          a search direction, and it begins where the reader is STANDING. Flipping back to an earlier
          chapter changes where a backward search starts and leaves the furthest point untouched. */}
      <button className="sp-spoiler sp-opt" onClick={onToggleBackward} aria-pressed={backward}>
        <span className="sp-spoiler-text">
          <span className="sp-spoiler-label">{t("search.backward")}</span>
          <span className="sp-spoiler-sub">{t("search.backwardSub")}</span>
        </span>
        <span className={`rp-switch${backward ? " on" : ""}`} aria-hidden><span className="rp-knob" /></span>
      </button>

      {/* spoiler-safe toggle — app furniture, pinned side + app language */}
      <button className="sp-spoiler" onClick={onToggleSpoiler} aria-pressed={spoilerSafe}>
        <span className="sp-spoiler-text">
          <span className="sp-spoiler-label">{t("search.spoiler")}</span>
          {/* One wording, because there is one boundary: where the reader is. It used to switch to the
              furthest point's name whenever the two had parted, which is exactly the conflation this
              panel no longer makes. */}
          <span className="sp-spoiler-sub" dir="auto">
            {t("search.spoilerSub", { pos: positionLabel })}
          </span>
        </span>
        <span className={`rp-switch${spoilerSafe ? " on" : ""}`} aria-hidden><span className="rp-knob" /></span>
      </button>

      {/* THE WAY BACK TO THE FURTHEST POINT READ — the same control the Contents panel offers, here
          because this is the other place a reader learns they are behind it. Offered on exactly the
          same condition, so the two can never disagree, and shown whether or not anything has been
          typed — a reader may open Search for this alone.

          IT NAMES ITS OWN PLACE. `furthestLabel` is the deepest point reached; `positionLabel` above is
          where the reader stands, and the seal's boundary. Two labels because they are two places, and
          this row is reading progress — it decides nothing about what was searched or what is hidden.

          It is INDEPENDENT of the return pill. That one appears after jumping to a result and offers
          the way back to where the reader was a moment ago; this one is durable and offers the furthest
          point they ever read to. Both may be on screen at once, and neither suppresses the other. */}
      {behindFurthest && furthestLabel && onGoFurthest && (
        <FurthestReturn label={furthestLabel} onGo={onGoFurthest} onReset={onResetFurthest} />
      )}

      <div className="rp-scroll sp-results" ref={resultsRef} onScroll={onResultsScroll}>
        {/* before typing */}
        {!q && (
          <div className="sp-hint">
            <div className="sp-hint-title">{t("search.beforeTitle")}</div>
            <div className="sp-hint-body">{t("search.beforeBody")}</div>
          </div>
        )}

        {/* RAWY-89: lively in-progress feedback — an animated spinner + live "N found · X% scanned" +
            a scan bar, so a long book (1000+ chapters) clearly feels like it's actively searching. */}
        {q && searching && (
          <div className="sp-searching">
            <span className="sp-spinner" aria-hidden />
            <span className="sp-searching-text">
              {t("search.searchingCount", { n: localeNum(hits.length, lang), p: localeNum(Math.round(searchProgress * 100), lang) })}
            </span>
            <span className="sp-scanbar" aria-hidden><span className="sp-scanbar-fill" style={{ width: `${Math.round(searchProgress * 100)}%` }} /></span>
          </div>
        )}

        {/* no matches (only once the scan is finished) */}
        {q && !searching && hits.length === 0 && (
          <>
            <div className="sp-empty">
              <div className="sp-empty-title">{t("search.none", { q })}</div>
              <div className="sp-empty-body">{t("search.noneBody")}</div>
            </div>
            {/* NOTHING BEHIND THE READER — and, sealed, nothing was looked for ahead. Saying only «no
                matches» would let that read as «none in the book», which is more than Sard knows. */}
            {!reveal && (
              <div className="sp-sealed">
                <div className="sp-sealed-count">{t("search.hidden")}</div>
                <div className="sp-sealed-body">{t("search.hiddenBody")}</div>
                {/* Reading backward, nothing ahead was searched, so there is nothing found to
                    un-hide — the way to see it is to turn the direction round, which is a control of
                    its own. Offering it here would promise something this press cannot do. */}
                {!backward && (
                  <button className="sp-sealed-reveal" onClick={() => onRevealAhead(true)}>{t("search.reveal")}</button>
                )}
              </div>
            )}
          </>
        )}

        {/* results — up-to-position rows stream in AS FOUND (even while searching); the summary chrome
            (count · you-are-here · sealed card · notes) settles in only once the scan finishes so it
            doesn't flicker as counts climb. Ahead snippets are never rendered while spoiler-safe. */}
        {q && hits.length > 0 && (
          <>
            {/* count — final only (the spinner carries the live count while scanning) */}
            {!searching && (
              <div className="sp-count">
                {/* WITH THE SEAL ON, THE ONLY NUMBER IS THE ONE THE READER HAS EARNED.
                    This said «14 matches · 4 up to your position», and the subtraction is the leak:
                    the reader learns there are ten ahead. Sealed, the line now carries the count up to
                    the position and nothing else — and since the sections ahead are no longer searched
                    at all, there is no total to accidentally reach for. Unsealed, it is the line it
                    has always been. */}
                {reveal
                  ? t("search.countAll", { n: localeNum(hits.length, lang) })
                  : t("search.countUpTo", { n: localeNum(upTo.length, lang) })}
              </div>
            )}

            {/* nothing before the position (spoiler-safe, all matches ahead) */}
            {!searching && !reveal && upTo.length === 0 && ahead.length > 0 && (
              <div className="sp-nothing-before" dir="auto">{t("search.nothingBefore", { pos: positionLabel })}</div>
            )}

            {/* up-to-position results (always real snippets) — stream in live. RAWY-175: only the first
                `renderLimit` render; the rest load as you scroll (all still reachable). */}
            {shownUpTo.map((h) => (
              <ResultRow
                key={h.cfi} hit={h} active={h.cfi === activeCfi} ahead={false}
                onJump={onJump} bookDir={bookDir} lang={lang} aheadLabel={t("search.ahead")}
              />
            ))}

            {/* the "you are here" boundary — final only, once all up-to rows are on screen (RAWY-175) */}
            {/* The boundary line does not depend on having COUNTED anything ahead — sealed, nothing
                ahead is counted by design. It is drawn when there is a boundary to draw. */}
            {!searching && allUpToShown && (ahead.length > 0 || (!reveal && upTo.length > 0)) && (
              <div className="sp-here" dir="auto">
                <span className="sp-here-line" />
                <span className="sp-here-label">{t("search.youAreHere", { pos: positionLabel })}</span>
                <span className="sp-here-line" />
              </div>
            )}

            {/* ahead matches when revealed (spoiler off / show-anyway) — windowed like the up-to rows */}
            {shownAhead.map((h) => (
              <ResultRow
                key={h.cfi} hit={h} active={h.cfi === activeCfi} ahead
                onJump={onJump} bookDir={bookDir} lang={lang} aheadLabel={t("search.ahead")}
              />
            ))}
            {!searching && allShown && reveal && spoilerSafe && revealAhead && (
              <button className="sp-hide-again" onClick={() => onRevealAhead(false)}>{t("search.hideAgain")}</button>
            )}

            {/* the sealed card — final only, spoiler-safe on with ahead matches (RAWY-175: once all the
                up-to rows are on screen, so it sits at the true bottom — as it always did) */}
            {/* THE SEAL. It used to appear only when matches ahead had been counted, and it named the
                count. Neither is possible now and neither should be: the sections ahead are not
                searched, so nothing is known about them — which is the strongest form of the promise
                the card makes. It therefore says what Sard DID, not what it found, and appears
                whenever the seal is on and there is something behind the reader to have searched. */}
            {!searching && allShown && !reveal && (
              <div className="sp-sealed">
                <div className="sp-sealed-count">{t("search.hidden")}</div>
                <div className="sp-sealed-body">{t("search.hiddenBody")}</div>
                {/* Reading backward, nothing ahead was searched, so there is nothing found to
                    un-hide — the way to see it is to turn the direction round, which is a control of
                    its own. Offering it here would promise something this press cannot do. */}
                {!backward && (
                  <button className="sp-sealed-reveal" onClick={() => onRevealAhead(true)}>{t("search.reveal")}</button>
                )}
              </div>
            )}

            {/* A quiet reminder that matching ignores tashkīl (design's Arabic panel note) */}
            {!searching && allShown && bookDir === "rtl" && <div className="sp-tashkil-note">{t("search.tashkilNote")}</div>}
          </>
        )}
      </div>
    </aside>
  );
}
