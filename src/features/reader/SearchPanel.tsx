// In-book search panel (RAWY-88, Plan Phase 7) — built from docs/design/In-Book Search (standalone).html.
// A leading-side (physical-left, like Contents — RAWY-32/D21) slide-in: an input that searches the
// CURRENT book (foliate's whole-book search), a results list (chapter · location + a snippet with the
// match bolded), a match count, jump-to-result, and the marquee SPOILER-SAFE toggle (on by default):
// matches BEYOND the reader's furthest-read position collapse into ONE sealed card — a count, never a
// snippet. The panel chrome is APP furniture (UI language + pinned side); the snippets are BOOK text
// (they follow the book's own face + direction), exactly like the page.

import { useEffect, useRef } from "react";

import { useI18n } from "../../i18n";
import { localeNum } from "../../lib/format";
import type { SearchHit } from "../../reader-engine/FoliateController";

interface Props {
  open: boolean;
  onClose: () => void;
  bookTitle: string | null;
  positionLabel: string; // the reader's current chapter/position, for the toggle + "you are here"
  bookDir: "rtl" | "ltr"; // the BOOK's direction — snippets follow it (not the UI)
  query: string;
  onQuery: (q: string) => void;
  searching: boolean;
  hits: SearchHit[];
  spoilerSafe: boolean;
  onToggleSpoiler: () => void;
  revealAhead: boolean; // "show them anyway" — reveal ahead matches this once (spoiler stays on)
  onRevealAhead: (v: boolean) => void;
  activeCfi: string | null;
  onJump: (hit: SearchHit) => void;
}

// One result row: chapter · location badge, then the snippet with the match in gold.
function ResultRow({
  hit, active, ahead, onJump, bookDir, lang, aheadLabel,
}: {
  hit: SearchHit; active: boolean; ahead: boolean; onJump: () => void;
  bookDir: "rtl" | "ltr"; lang: string; aheadLabel: string;
}) {
  return (
    <button className={`sr-row${active ? " active" : ""}${ahead ? " ahead" : ""}`} onClick={onJump}>
      <span className="sr-meta">
        <span className="sr-chapter" dir="auto">{hit.chapterLabel}</span>
        {ahead && <span className="sr-ahead-tag">{aheadLabel}</span>}
        <span className="sr-loc">٪{localeNum(Math.round(hit.frac * 100), lang)}</span>
      </span>
      <span className="sr-snippet" dir={bookDir}>
        {hit.pre}
        <mark className="sr-hit">{hit.match}</mark>
        {hit.post}
      </span>
    </button>
  );
}

export function SearchPanel({
  open, onClose, bookTitle, positionLabel, bookDir,
  query, onQuery, searching, hits,
  spoilerSafe, onToggleSpoiler, revealAhead, onRevealAhead,
  activeCfi, onJump,
}: Props) {
  const { t, lang, dir } = useI18n();
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus the input whenever the panel opens (so ⌘F / the button land ready to type).
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const upTo = hits.filter((h) => !h.ahead);
  const ahead = hits.filter((h) => h.ahead);
  const reveal = !spoilerSafe || revealAhead; // show the ahead snippets?
  const q = query.trim();

  return (
    <aside className={`reader-panel rp-lead search-panel${open ? " show" : ""}`} dir={dir} aria-hidden={!open}>
      <div className="rp-head">
        <div className="rp-head-titles">
          <span className="rp-title">{t("search.title")}</span>
          <span className="rp-submeta" dir="auto">{bookTitle || t("reader.untitledBook")}</span>
        </div>
        <div className="rp-head-actions">
          <button className="rp-x" onClick={onClose} aria-label="✕">✕</button>
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

      {/* spoiler-safe toggle — app furniture, pinned side + app language */}
      <button className="sp-spoiler" onClick={onToggleSpoiler} aria-pressed={spoilerSafe}>
        <span className="sp-spoiler-text">
          <span className="sp-spoiler-label">{t("search.spoiler")}</span>
          <span className="sp-spoiler-sub" dir="auto">
            {t("search.spoilerSub", { pos: positionLabel })}
          </span>
        </span>
        <span className={`rp-switch${spoilerSafe ? " on" : ""}`} aria-hidden><span className="rp-knob" /></span>
      </button>

      <div className="rp-scroll sp-results">
        {/* before typing */}
        {!q && (
          <div className="sp-hint">
            <div className="sp-hint-title">{t("search.beforeTitle")}</div>
            <div className="sp-hint-body">{t("search.beforeBody")}</div>
          </div>
        )}

        {/* searching */}
        {q && searching && <div className="sp-searching">{t("search.searching")}</div>}

        {/* no matches */}
        {q && !searching && hits.length === 0 && (
          <div className="sp-empty">
            <div className="sp-empty-title">{t("search.none", { q })}</div>
            <div className="sp-empty-body">{t("search.noneBody")}</div>
          </div>
        )}

        {/* results */}
        {q && !searching && hits.length > 0 && (
          <>
            <div className="sp-count">
              {reveal
                ? t("search.countAll", { n: localeNum(hits.length, lang) })
                : t("search.count", { n: localeNum(hits.length, lang), m: localeNum(upTo.length, lang) })}
            </div>

            {/* nothing before the position (spoiler-safe, all matches ahead) */}
            {!reveal && upTo.length === 0 && ahead.length > 0 && (
              <div className="sp-nothing-before" dir="auto">{t("search.nothingBefore", { pos: positionLabel })}</div>
            )}

            {/* up-to-position results (always real snippets) */}
            {upTo.map((h) => (
              <ResultRow
                key={h.cfi} hit={h} active={h.cfi === activeCfi} ahead={false}
                onJump={() => onJump(h)} bookDir={bookDir} lang={lang} aheadLabel={t("search.ahead")}
              />
            ))}

            {/* the "you are here" boundary — shown whenever there are ahead matches to place it against */}
            {ahead.length > 0 && (
              <div className="sp-here" dir="auto">
                <span className="sp-here-line" />
                <span className="sp-here-label">{t("search.youAreHere", { pos: positionLabel })}</span>
                <span className="sp-here-line" />
              </div>
            )}

            {/* ahead matches: sealed (spoiler-safe) OR revealed (off / show-anyway) */}
            {ahead.length > 0 && (reveal
              ? (
                <>
                  {ahead.map((h) => (
                    <ResultRow
                      key={h.cfi} hit={h} active={h.cfi === activeCfi} ahead
                      onJump={() => onJump(h)} bookDir={bookDir} lang={lang} aheadLabel={t("search.ahead")}
                    />
                  ))}
                  {spoilerSafe && revealAhead && (
                    <button className="sp-hide-again" onClick={() => onRevealAhead(false)}>{t("search.hideAgain")}</button>
                  )}
                </>
              )
              : (
                <div className="sp-sealed">
                  <div className="sp-sealed-count">{t("search.hidden", { n: localeNum(ahead.length, lang) })}</div>
                  <div className="sp-sealed-body">{t("search.hiddenBody")}</div>
                  <button className="sp-sealed-reveal" onClick={() => onRevealAhead(true)}>{t("search.reveal")}</button>
                </div>
              ))}

            {/* Arabic-first: a quiet reminder that matching ignores tashkīl (design's Arabic panel note) */}
            {bookDir === "rtl" && <div className="sp-tashkil-note">{t("search.tashkilNote")}</div>}
          </>
        )}
      </div>
    </aside>
  );
}
