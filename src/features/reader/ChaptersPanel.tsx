// Chapters / TOC panel (RAWY-21, band C-II). A leading-side slide-in panel listing the
// book's table of contents (from foliate). The current chapter is marked; clicking a row
// jumps via the entry's href (CFI-equivalent navigation). When "Hide chapter titles" is on
// (the RAWY-13 anti-spoiler setting) it shows neutral "Chapter N" labels instead of titles.
// Placement + content follow the UI direction (RAWY-30) — chapters sits on the UI-leading
// edge, the same side as the toolbar "contents" button. Book-derived chapter titles use
// dir="auto" so Arabic titles still render RTL inside an LTR UI (and vice-versa).

import { useI18n } from "../../i18n";
import { localeNum } from "../../lib/format";
import type { TocEntry } from "../../reader-engine/FoliateController";

interface Props {
  open: boolean;
  onClose: () => void;
  toc: TocEntry[];
  currentHref: string | null;
  hideTitles: boolean;
  onToggleHideTitles: () => void;
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
  onJump,
  fraction,
}: Props) {
  const { t, lang, dir } = useI18n();
  const pct = Math.round(fraction * 100);

  return (
    <aside className={`reader-panel rp-lead${open ? " show" : ""}`} dir={dir} aria-hidden={!open}>
      <div className="rp-head">
        <span className="rp-title">{t("panel.contents")}</span>
        <button className="rp-x" onClick={onClose} aria-label="✕">✕</button>
      </div>

      <div className="rp-meta">
        {t("panel.chaptersMeta", { n: localeNum(toc.length, lang), p: localeNum(pct, lang) })}
      </div>

      {/* clear labelled anti-spoiler toggle (RAWY-22) */}
      <button className="rp-toggle" onClick={onToggleHideTitles} aria-pressed={hideTitles}>
        <span className="rp-toggle-text">
          <span className="rp-toggle-label">{t("theme.hideTitles")}</span>
          <span className="rp-toggle-hint">{hideTitles ? t("panel.titlesHidden") : t("panel.spoilerSafe")}</span>
        </span>
        <span className={`rp-switch${hideTitles ? " on" : ""}`} aria-hidden>
          <span className="rp-knob" />
        </span>
      </button>

      <div className="rp-scroll">
        {toc.length === 0 && <div className="rp-empty">{t("panel.noChapters")}</div>}
        {toc.map((c, i) => {
          const active = !!c.href && c.href === currentHref;
          const label = hideTitles ? t("panel.chapter", { n: localeNum(i + 1, lang) }) : c.label || t("panel.chapter", { n: localeNum(i + 1, lang) });
          return (
            <button
              key={`${c.href ?? "x"}-${i}`}
              className={`rp-row toc-row${active ? " active" : ""}`}
              style={{ paddingInlineStart: 11 + c.level * 14 }}
              onClick={() => c.href && onJump(c.href)}
              disabled={!c.href}
            >
              <span className="toc-num">{localeNum(i + 1, lang)}</span>
              <span className="toc-label" dir="auto">{label}</span>
              <span className={`toc-dot${active ? " current" : ""}`} />
            </button>
          );
        })}
      </div>
    </aside>
  );
}
