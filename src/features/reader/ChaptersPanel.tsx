// Chapters / TOC panel (RAWY-21, band C-II). A leading-side slide-in panel listing the
// book's table of contents (from foliate). The current chapter is marked; clicking a row
// jumps via the entry's href (CFI-equivalent navigation). When "Hide chapter titles" is on
// (the RAWY-13 anti-spoiler setting) it shows neutral "Chapter N" labels instead of titles.
// Placement + content follow the UI direction (RAWY-30) — chapters sits on the UI-leading
// edge, the same side as the toolbar "contents" button. Book-derived chapter titles use
// dir="auto" so Arabic titles still render RTL inside an LTR UI (and vice-versa).

import { useI18n } from "../../i18n";
import { extractChapterNumber, localeNum } from "../../lib/format";
import type { TocEntry } from "../../reader-engine/FoliateController";

interface Props {
  open: boolean;
  onClose: () => void;
  toc: TocEntry[];
  currentHref: string | null;
  hideTitles: boolean;
  onToggleHideTitles: () => void;
  // RAWY-69: independent from hideTitles — hides the section's leading in-body "first line"
  // (often a repeated/spoiler title) without touching the app's own chapter-title display.
  hideFirstLine: boolean;
  onToggleHideFirstLine: () => void;
  onJump: (href: string) => void;
  fraction: number;
}

export function ChaptersPanel({
  open,
  onClose,
  toc,
  currentHref,
  hideTitles,
  onToggleHideTitles,
  hideFirstLine,
  onToggleHideFirstLine,
  onJump,
  fraction,
}: Props) {
  const { t, lang, dir } = useI18n();
  const pct = Math.round(fraction * 100);

  return (
    <aside className={`reader-panel rp-lead${open ? " show" : ""}`} dir={dir} aria-hidden={!open}>
      {/* header (RAWY-33; RAWY-36): title + chapter/percent meta + close. */}
      <div className="rp-head">
        <div className="rp-head-titles">
          <span className="rp-title">{t("panel.contents")}</span>
          <span className="rp-submeta">
            {t("panel.chaptersMeta", { n: localeNum(toc.length, lang), p: localeNum(pct, lang) })}
          </span>
        </div>
        <div className="rp-head-actions">
          <button className="rp-x" onClick={onClose} aria-label="✕">✕</button>
        </div>
      </div>

      {/* anti-spoiler controls — TWO independent toggles (RAWY-69, split from one): the app's own
          chapter-title display vs. an in-body leading "first line" that's often a repeated title
          and can itself carry spoilers (RAWY-68's markInBodyHeading). Either, both, or neither. */}
      <button className="rp-spoiler" onClick={onToggleHideTitles} aria-pressed={hideTitles}>
        <span className="rp-spoiler-label">{t("theme.hideTitles")}</span>
        <span className={`rp-switch${hideTitles ? " on" : ""}`} aria-hidden>
          <span className="rp-knob" />
        </span>
      </button>
      <button className="rp-toggle" onClick={onToggleHideFirstLine} aria-pressed={hideFirstLine}>
        <span className="rp-toggle-text">
          <span className="rp-toggle-label">{t("panel.hideFirstLine")}</span>
          <span className="rp-toggle-hint">{t("panel.hideFirstLineHint")}</span>
        </span>
        <span className={`rp-switch${hideFirstLine ? " on" : ""}`} aria-hidden>
          <span className="rp-knob" />
        </span>
      </button>

      <div className="rp-scroll">
        {toc.length === 0 && <div className="rp-empty">{t("panel.noChapters")}</div>}
        {toc.map((c, i) => {
          const active = !!c.href && c.href === currentHref;
          // RAWY-67: show the book's OWN chapter number (parsed from its real TOC label — e.g. a
          // single-volume import that starts at "الفصل 200" correctly shows 200, not the imposed
          // list position 1) — never fabricated; a book/entry with no extractable number falls
          // back to the position, same as before.
          const realNum = extractChapterNumber(c.label);
          const badgeNum = realNum ?? i + 1;
          // RAWY-70: when titles are hidden, the row reads "الفصل N" / "Chapter N" (localized) once
          // — not a bare "N" (RAWY-69) and not the number twice (RAWY-68's double-numbering it
          // replaced). It's the single, enlarged, readable identifier for the row; the book's own
          // title text is withheld (that's the anti-spoiler point). With titles SHOWN, the row is
          // the book's own title (falling back to "Chapter N" only when that TOC entry has none).
          const chapterLabel = t("panel.chapter", { n: localeNum(badgeNum, lang) });
          const label = hideTitles ? null : c.label || chapterLabel;
          return (
            <button
              key={`${c.href ?? "x"}-${i}`}
              className={`rp-row toc-row${active ? " active" : ""}`}
              style={{ paddingInlineStart: 11 + c.level * 14 }}
              onClick={() => c.href && onJump(c.href)}
              disabled={!c.href}
            >
              {/* RAWY-69/70: when titles are hidden the row's sole content is the enlarged
                  "الفصل N" / "Chapter N" (readable on its own — no small/muted secondary index,
                  no title text). When shown, the small numeric badge sits beside the title. */}
              {hideTitles ? (
                <span className="toc-num big" dir="auto">{chapterLabel}</span>
              ) : (
                <span className="toc-num">{localeNum(badgeNum, lang)}</span>
              )}
              {label && (
                <span className="toc-label" dir="auto">
                  {label}
                </span>
              )}
              <span className={`toc-dot${active ? " current" : ""}`} />
            </button>
          );
        })}
      </div>
    </aside>
  );
}
