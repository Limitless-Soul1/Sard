// THE READER HUB — design D3–D6: one bottom sheet, four tabs.
//
// WHY ONE SHEET. The desktop reader reaches Contents, Typography, Theme and Notes through a six-button
// top bar and two docked side panels. The design's own reasoning: "Six 42px targets in a row is a scan
// task. A tabbed sheet is one target and puts controls in thumb reach." So the phone learns one gesture
// instead of six icons, and the sheet opens in the bottom half of the screen where a thumb already is.
//
// EVERY TAB IS BACKED. Contents is the session's own `toc`/`tocIndex`/`jumpHref`; Bookmarks is
// `bookmarksForBook`; Text writes through `update()`, the same `Partial<ReadingStyle>` funnel the
// desktop settings panel uses, so unified/per-book scope is honoured without this file knowing about
// it; Theme is `THEMES` + `setBookTheme`; Notes is `highlightsForBook` + `notesForBook`. Nothing here
// keeps its own copy of reading state.
//
// WHAT THE DESIGN ASKS FOR AND SARD DOES NOT HAVE: a per-chapter reading-time estimate ("9 min"). Sard
// computes none, so the row shows the chapter's own position instead of a fabricated duration — the
// same honest fallback the Continue card uses.

import { useEffect, useState } from "react";

import { useI18n } from "../../i18n";
import { localeDigits } from "../../lib/format";
import {
  bookmarksForBook,
  highlightsForBook,
  notesForBook,
  type BookmarkRow,
  type HighlightRow,
  type NoteRow,
} from "../../lib/ipc";
import { THEMES, THEME_ORDER } from "../../theme/themes";
// `resolveTheme` is the one place the builtin/custom distinction is handled; the theme module
// itself says to prefer it over `THEMES[id]`. THEME_ORDER above is builtin-only, so those stay.
import { resolveTheme } from "../../theme";
import type { ThemeId } from "../../theme/tokens";
import type { ReadingStyle, DiacriticsMode, Align } from "../../reader-engine/injectedCss";
import type { TocEntry } from "../../reader-engine/FoliateController";
import { Icon } from "../components/Icon";

export type HubTab = "contents" | "text" | "theme" | "notes";

interface Props {
  bookId: string;
  tab: HubTab;
  onTab: (t: HubTab) => void;
  onClose: () => void;
  // contents
  toc: TocEntry[];
  tocIndex: number;
  readHrefs: Set<string>;
  onJumpHref: (href: string) => void;
  onJumpCfi: (cfi: string) => void;
  hideTitles: boolean;
  // text
  style: ReadingStyle | null;
  update: (patch: Partial<ReadingStyle>) => void;
  // theme
  bookThemeId: ThemeId;
  setBookTheme: (id: ThemeId) => void;
}

const TABS: { id: HubTab; key: string }[] = [
  { id: "contents", key: "reader.contents" },
  { id: "text", key: "reader.typography" },
  { id: "theme", key: "m.theme" },
  { id: "notes", key: "reader.notes" },
];

export function ReaderHub(p: Props) {
  const { t } = useI18n();
  return (
    <div className="mh-scrim" onClick={p.onClose}>
      <div
        className="mh-sheet"
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") p.onClose();
        }}
      >
        {/* The design draws a grabber and no close button: "Sheets never need a close button" — the
            backdrop and Back both dismiss, and Back is the one a phone reader already knows. */}
        <div className="mh-grab" aria-hidden="true" />
        <div className="mh-tabs" role="tablist">
          {TABS.map((x) => (
            <button
              key={x.id}
              type="button"
              role="tab"
              aria-selected={p.tab === x.id}
              className={`mh-tab${p.tab === x.id ? " on" : ""}`}
              onClick={() => p.onTab(x.id)}
            >
              {t(x.key as Parameters<typeof t>[0])}
            </button>
          ))}
        </div>
        <div className="mh-body">
          {p.tab === "contents" ? <ContentsTab {...p} /> : null}
          {p.tab === "text" ? <TextTab style={p.style} update={p.update} /> : null}
          {p.tab === "theme" ? <ThemeTab bookThemeId={p.bookThemeId} setBookTheme={p.setBookTheme} /> : null}
          {p.tab === "notes" ? <NotesTab bookId={p.bookId} onJumpCfi={p.onJumpCfi} /> : null}
        </div>
      </div>
    </div>
  );
}

// ---- D3 contents ---------------------------------------------------------------------------------

function ContentsTab(p: Props) {
  const { t } = useI18n();
  const [mode, setMode] = useState<"chapters" | "bookmarks">("chapters");
  const [marks, setMarks] = useState<BookmarkRow[]>([]);

  useEffect(() => {
    let alive = true;
    bookmarksForBook(p.bookId).then((b) => alive && setMarks(b)).catch(() => {});
    return () => {
      alive = false;
    };
  }, [p.bookId]);

  return (
    <>
      <div className="mh-chips">
        <button
          type="button"
          className={`mh-chip${mode === "chapters" ? " on" : ""}`}
          onClick={() => setMode("chapters")}
        >
          {t("reader.contents")}
        </button>
        <button
          type="button"
          className={`mh-chip${mode === "bookmarks" ? " on" : ""}`}
          onClick={() => setMode("bookmarks")}
        >
          {t("lib.nav.bookmarks")}
          {marks.length ? ` · ${localeDigits(String(marks.length))}` : ""}
        </button>
        <span className="mh-count">
          {mode === "chapters"
            ? `${localeDigits(String(p.toc.length))} ${t("reader.contents")}`
            : `${localeDigits(String(marks.length))}`}
        </span>
      </div>

      <ul className="mh-list">
        {mode === "chapters"
          ? p.toc.map((e, i) => (
              <li key={`${e.href ?? i}-${i}`}>
                <button
                  type="button"
                  className={`mh-row${i === p.tocIndex ? " on" : ""}`}
                  style={{ paddingInlineStart: `${14 + e.level * 12}px` }}
                  onClick={() => e.href && p.onJumpHref(e.href)}
                  disabled={!e.href}
                  aria-current={i === p.tocIndex ? "true" : undefined}
                >
                  <span className="mh-num">{localeDigits(String(i + 1))}</span>
                  {/* The spoiler guard the product already has: with "hide chapter titles" on, a
                      chapter you have not reached shows its number and nothing else. */}
                  <span className="mh-label" dir="auto">
                    {p.hideTitles && !p.readHrefs.has(e.href ?? "") && i !== p.tocIndex
                      ? "—"
                      : e.label}
                  </span>
                  {/* The design puts a reading-time estimate here. Sard computes none, so the row
                      says only what is true: which chapter you are in, and which you have read. */}
                  {i === p.tocIndex ? (
                    <span className="mh-now">{t("m.now")}</span>
                  ) : p.readHrefs.has(e.href ?? "") ? (
                    <span className="mh-dot" aria-label={t("m.read")} />
                  ) : null}
                </button>
              </li>
            ))
          : marks.length === 0
            ? <li className="mh-empty">{t("m.noBookmarks")}</li>
            : marks.map((b) => (
                <li key={b.id}>
                  <button type="button" className="mh-row" onClick={() => p.onJumpCfi(b.cfi)}>
                    <span className="mh-num">
                      <Icon name="bookmark" />
                    </span>
                    <span className="mh-label" dir="auto">
                      {b.label || t("bookmark.here")}
                    </span>
                  </button>
                </li>
              ))}
      </ul>
    </>
  );
}

// ---- D4 text -------------------------------------------------------------------------------------

const SPACING: { id: string; lh: number; key: string }[] = [
  { id: "tight", lh: 1.5, key: "m.tight" },
  { id: "normal", lh: 1.75, key: "m.normal" },
  { id: "airy", lh: 2.05, key: "m.airy" },
];
const MARGINS: { id: string; px: number; key: string }[] = [
  { id: "narrow", px: 16, key: "m.narrow" },
  { id: "comfortable", px: 26, key: "m.comfortable" },
  { id: "wide", px: 40, key: "m.wide" },
];
// `dim` was removed from the product; DiacriticsMode is "show" | "hide" now. Keeping a third
// option here would offer a control that does nothing.
const DIACRITICS: DiacriticsMode[] = ["show", "hide"];

function TextTab({ style, update }: { style: ReadingStyle | null; update: (p: Partial<ReadingStyle>) => void }) {
  const { t } = useI18n();
  if (!style) return null;

  const zoomPct = Math.round(style.zoom * 100);
  const nearest = <T extends { lh?: number; px?: number }>(list: T[], val: number, key: "lh" | "px") =>
    list.reduce((a, b) => (Math.abs((b[key] as number) - val) < Math.abs((a[key] as number) - val) ? b : a));

  return (
    <div className="mh-pane">
      {/* Every control shows its CURRENT VALUE beside its name — the design's D4 rule. */}
      <div className="mh-ctrl">
        <span className="mh-ctrl-name">{t("type.size")}</span>
        <span className="mh-ctrl-val">{localeDigits(String(zoomPct))}%</span>
      </div>
      <div className="mh-stepper">
        <button type="button" onClick={() => update({ zoom: Math.max(0.7, +(style.zoom - 0.05).toFixed(2)) })} aria-label="−">
          −
        </button>
        <span className="mh-stepper-bar" aria-hidden="true">
          <span style={{ inlineSize: `${Math.min(100, Math.max(0, ((style.zoom - 0.7) / 1.1) * 100))}%` }} />
        </span>
        <button type="button" onClick={() => update({ zoom: Math.min(1.8, +(style.zoom + 0.05).toFixed(2)) })} aria-label="+">
          +
        </button>
      </div>

      <Segment
        label={t("type.lineSpacing")}
        options={SPACING.map((s) => ({ id: s.id, label: t(s.key as Parameters<typeof t>[0]) }))}
        active={nearest(SPACING, style.lineHeight, "lh").id}
        onPick={(id) => update({ lineHeight: SPACING.find((s) => s.id === id)!.lh })}
      />

      <Segment
        label={t("type.margins")}
        options={MARGINS.map((m) => ({ id: m.id, label: t(m.key as Parameters<typeof t>[0]) }))}
        active={nearest(MARGINS, style.marginPx, "px").id}
        onPick={(id) => update({ marginPx: MARGINS.find((m) => m.id === id)!.px })}
      />

      {/* THE CONTROL THE DESIGN OMITS. Sard is Arabic-first and has shipped tashkīl show/dim/hide
          since long before this design existed; dropping it because a prototype forgot it would be a
          real loss of function on the one script the product is built around. */}
      <Segment
        label={t("type.diacritics")}
        options={DIACRITICS.map((d) => ({ id: d, label: t(`diacritics.${d}` as Parameters<typeof t>[0]) }))}
        active={style.diacritics}
        onPick={(id) => update({ diacritics: id as DiacriticsMode })}
      />

      <label className="mh-switch">
        <span className="mh-ctrl-name">{t("type.alignJustify")}</span>
        <input
          type="checkbox"
          checked={style.align === "justify"}
          onChange={(e) => update({ align: (e.target.checked ? "justify" : "start") as Align })}
        />
        <span className="mh-switch-track" aria-hidden="true">
          <span className="mh-switch-knob" />
        </span>
      </label>
    </div>
  );
}

function Segment({
  label,
  options,
  active,
  onPick,
}: {
  label: string;
  options: { id: string; label: string }[];
  active: string;
  onPick: (id: string) => void;
}) {
  return (
    <div className="mh-seg-wrap">
      <span className="mh-ctrl-name">{label}</span>
      <div className="mh-seg" role="group">
        {options.map((o) => (
          <button
            key={o.id}
            type="button"
            className={`mh-seg-btn${o.id === active ? " on" : ""}`}
            aria-pressed={o.id === active}
            onClick={() => onPick(o.id)}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

// ---- D5 theme ------------------------------------------------------------------------------------

function ThemeTab({ bookThemeId, setBookTheme }: { bookThemeId: ThemeId; setBookTheme: (id: ThemeId) => void }) {
  const { t } = useI18n();
  // The design shows fifteen; Sard has SIXTEEN, and Moonlit Sky is not dropped to match a prototype.
  const light = THEME_ORDER.filter((id) => !THEMES[id].dark);
  const dark = THEME_ORDER.filter((id) => THEMES[id].dark);
  const group = (ids: ThemeId[], label: string) => (
    <>
      <div className="mh-group">{label}</div>
      <div className="mh-swatches">
        {ids.map((id) => {
          const th = resolveTheme(id);
          return (
            <button
              key={id}
              type="button"
              className={`mh-swatch${id === bookThemeId ? " on" : ""}`}
              onClick={() => setBookTheme(id)}
              aria-pressed={id === bookThemeId}
            >
              {/* Real paper and real ink — the design's "swatches show real paper and ink". */}
              <span className="mh-swatch-aa" style={{ background: th.colors.paperBg, color: th.colors.text }}>
                Aa
              </span>
              <span className="mh-swatch-name">{th.name}</span>
            </button>
          );
        })}
      </div>
    </>
  );
  return (
    <div className="mh-pane">
      {group(light, t("m.themesLight"))}
      {group(dark, t("m.themesDark"))}
    </div>
  );
}

// ---- D6 notes ------------------------------------------------------------------------------------

function NotesTab({ bookId, onJumpCfi }: { bookId: string; onJumpCfi: (cfi: string) => void }) {
  const { t } = useI18n();
  const [hl, setHl] = useState<HighlightRow[]>([]);
  const [notes, setNotes] = useState<NoteRow[]>([]);

  useEffect(() => {
    let alive = true;
    highlightsForBook(bookId).then((h) => alive && setHl(h)).catch(() => {});
    notesForBook(bookId).then((n) => alive && setNotes(n)).catch(() => {});
    return () => {
      alive = false;
    };
  }, [bookId]);

  // A highlight carries the passage; a note carries the reader's words and may or may not quote one.
  // The design shows the quote with a rule under it and the note beneath — the same two parts.
  const items = [
    ...hl.map((h) => ({
      id: h.id,
      cfi: h.cfi as string | null,
      text: h.text_excerpt ?? "",
      note: null as string | null,
      chapter: h.chapter_label,
    })),
    ...notes.map((n) => ({
      id: n.id,
      cfi: n.cfi,
      text: n.title ?? "",
      note: n.body,
      chapter: n.chapter_label,
    })),
  ];

  if (items.length === 0) return <p className="mh-empty">{t("m.noMarks")}</p>;

  return (
    <ul className="mh-list">
      {items.map((it) => (
        <li key={it.id}>
          <button type="button" className="mh-mark" onClick={() => it.cfi && onJumpCfi(it.cfi)}>
            {it.chapter ? <span className="mh-mark-where">{it.chapter}</span> : null}
            <span className="mh-mark-quote" dir="auto">
              {it.text}
            </span>
            {it.note ? (
              <span className="mh-mark-note" dir="auto">
                {it.note}
              </span>
            ) : null}
          </button>
        </li>
      ))}
    </ul>
  );
}
