// Annotations panel (RAWY-21, band C-II): a trailing-side slide-in panel with Notes |
// Highlights tabs that READ what RAWY-20 stored. Each item shows its chapter label; click
// jumps to its location via CFI. Notes are editable/deletable inline and can be added as a
// standalone "margin note" at the current spot (the affordance deferred from RAWY-20).
// Highlights can be recoloured or deleted from the list. State comes from useAnnotations,
// so the in-context layer and this panel always agree. Placement + content follow the UI
// direction (RAWY-30) — the trailing edge, same side as the toolbar annotations button;
// book-derived text (chapter labels, excerpts, note bodies) uses dir="auto".
//
// RAWY-206 — SOURCE FILTER (this book / a specific book / all books), composing with all three tabs:
//   • "This book" (the DEFAULT, every time the panel opens — no persistence, matching the Inbox's
//     per-mount filters) is the ORIGINAL store-driven path, untouched: live, and fully editable
//     (inline edit/delete/recolour/add-margin-note).
//   • Another book / all books reuses the LIBRARY's own queries — `annotations_all` (RAWY-203/204) and
//     `bookmarks_all` (RAWY-202) — no parallel query. Those rows are READ-ONLY (jump/open only): editing
//     needs that book's store, which only the open book has. The rows carry NO edit/delete controls and a
//     `.rp-hint` says so — a control that looks live but does nothing is the RAWY-193/205 class of bug.
//   • Clicking a row in the CURRENT book jumps in place (`onJump`); a row in ANOTHER book goes through
//     `onOpenBook` → App's `setOpen` → Reader's `[initial.id]` effect re-opens at the row's cfi. Same-book
//     MUST use onJump: setOpen with the same id would not re-fire that effect (no jump).
//   • Cross-book data is fetched LAZILY (first time the source menu opens), so the default path costs
//     nothing extra.

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";

import { useI18n } from "../../i18n";
// Choosing several rows at once, said once for every list in Sard — see `listSelection`.
import { SelectionBar, SelectionBox, rowSelectProps, useListSelection } from "../../components/listSelection";
import type { TKey } from "../../i18n/locales/en";
import { resolveTheme, useTheme } from "../../theme";
import { useReader } from "../../reader-engine/store";
import { filterByTag, tagFilterStillValid } from "./noteTags";
import { useAnnotations } from "./annotationsStore";
import { useBookmarks } from "./bookmarksStore";
import { BookmarkShape } from "./BookmarkShape";
import { useBookmarkStyle } from "../../lib/bookmarkStyle";
import { ColorRow } from "./AnnotationLayer";
import { TagPicker } from "./TagPicker";
import { colorValue } from "./highlightColors";
import { localeNum } from "../../lib/format";
import {
  annoIsHighlight,
  annoIsNote,
  annotationsAll,
  bookmarksAll,
  noteTagsFor,
  noteTagsSet,
  tagsList,
  type AnnoItem,
  type BookmarkItem,
  type BookmarkRow,
  type HighlightColor,
  type HighlightRow,
  type NoteRow,
} from "../../lib/ipc";
import type { OpenTarget } from "./Reader"; // type-only: erased, so no runtime import cycle

/**
 * THE FIVE THINGS A READER LEAVES IN A BOOK.
 *
 * The order is not new: `dep.layer.mine.*` already fixes it for the four a reading copy carries —
 * highlights, notes, references, replacements — running from the plainest mark on the text to the
 * one that changes what the text says. Bookmarks come last because they are the odd one out: they
 * keep a PLACE rather than mark a passage, which is also why a deposit does not carry them.
 */
export type AnnoTab = "highlights" | "notes" | "references" | "replacements" | "bookmarks";
import { isArabicText } from "../../lib/typography";
// The two newest kinds of mark, from the SAME stores the reader writes them with — no second copy of
// the data and, for a replacement's on/off, no second copy of the truth. See `ReplacementsTab`.
import { useReferences } from "./referencesStore";
import { useReplacements } from "./replacementsStore";
// The dock side is DECLARED, not spelled here: `panelSides.ts` is the one place that says which
// physical edge this panel uses, and the toolbar groups its control from the same entry (RAWY-32).
import { panelDockClass } from "./panelSides";

/**
 * The categories, in the order `AnnoTab` explains — the single place the tab track is written from.
 * A new kind of mark is one entry here and one arm in the body below, never a fourth copy of a button.
 */
const CATEGORIES: { key: AnnoTab; label: TKey }[] = [
  { key: "highlights", label: "panel.highlights" },
  { key: "notes", label: "panel.notes" },
  { key: "references", label: "panel.references" },
  { key: "replacements", label: "panel.replacements" },
  { key: "bookmarks", label: "panel.bookmarks" },
];

/** RAWY-282: a hard cap on the note title, enforced at the INPUT rather than by trimming on save, so a
 *  reader never types text that is silently discarded. It is a heading, not a second body — the body is
 *  the place for length — and it also bounds the widest single word the card has to wrap. */
const NOTE_TITLE_MAX = 120;

// "current" | "all" | a book id
type Source = string;

function useHl() {
  const id = useTheme((s) => s.themeId);
  return resolveTheme(id).colors.highlight;
}

interface Props {
  open: boolean;
  onClose: () => void;
  onJump: (cfi: string) => void;
  /** RAWY-206: open a DIFFERENT book at a locator (App.setOpen — the Library's own path). */
  onOpenBook?: (t: OpenTarget) => void;
  initialTab?: AnnoTab;
}

export function AnnotationsPanel({ open, onClose, onJump, onOpenBook, initialTab = "notes" }: Props) {
  const { t, dir, lang } = useI18n();
  const [tab, setTab] = useState<AnnoTab>(initialTab);
  useEffect(() => setTab(initialTab), [initialTab]);
  const highlights = useAnnotations((s) => s.highlights);
  const allNotes = useAnnotations((s) => s.notes);
  const bookmarks = useBookmarks((s) => s.bookmarks);
  const currentBookId = useAnnotations((s) => s.bookId);
  // RAWY-205: an empty-body note is a pure tag ANCHOR for a body-less tagged highlight — not a note the
  // user wrote — so it is hidden from this list AND its count (the passage itself lives under Highlights).
  // RAWY-282: a note is REAL if it has a body OR a title. Previously body-only, which would now hide a
  // note the reader had reduced to a heading. Empty-body notes still exist as pure TAG anchors
  // (RAWY-205) and are still correctly excluded — they have neither.
  const notes = useMemo(
    () => allNotes.filter((n) => (n.body ?? "").trim() !== "" || (n.title ?? "").trim() !== ""),
    [allNotes],
  );
  // RAWY-282 (classification): the Highlights tab lists STANDALONE highlights only — one passage is one
  // logical item, so a highlight that carries a note belongs to Notes and must not be duplicated here.
  // The anchor itself is untouched: the mark still renders in the book, because this filters the LIST,
  // not the highlight.
  // Keyed on the VISIBLE notes, deliberately, not on "has any note row". A highlight can carry an
  // empty-body note that exists only to hold tags (RAWY-205); keying on row existence would hide such a
  // highlight from Highlights while Notes also refuses to show it, and the item would vanish from both.
  // Keying on the visible set makes the two lists exactly complementary — every item appears once.
  const notedHighlightIds = useMemo(
    () => new Set(notes.map((n) => n.highlight_id).filter(Boolean) as string[]),
    [notes],
  );
  const standaloneHighlights = useMemo(
    () => highlights.filter((h) => !notedHighlightIds.has(h.id)),
    [highlights, notedHighlightIds],
  );

  // RAWY-206: source filter. Resets to "current" every time the panel opens (no persistence).
  const [source, setSource] = useState<Source>("current");
  // ONE ACTIVE MENU, not one boolean per control.
  //
  // Two independent booleans let both dropdowns be open at once, and they overlapped — each was
  // `position: absolute` under its own control with no knowledge of the other. Mutual exclusion by
  // COORDINATION (each open handler closing the other) would work until a third control arrived and
  // someone forgot; a single value cannot represent two open menus at all, so the bug is unavailable
  // by construction rather than merely fixed.
  const [menu, setMenu] = useState<"src" | "tag" | null>(null);
  const srcMenu = menu === "src";
  const tagMenu = menu === "tag";
  const setSrcMenu = (on: boolean) => setMenu(on ? "src" : null);
  const setTagMenu = (on: boolean) => setMenu(on ? "tag" : null);
  // DISMISSAL. `.lib-clickaway` — the Inbox's device — cannot be used here: it is `position: fixed`
  // and this panel is `transform`ed, which makes the panel its containing block, so the overlay could
  // never cover the window. The reader's own TTS speed popover has the same problem and solves it the
  // same way: document-level listeners in the CAPTURE phase, registered ONLY while a menu is open, so
  // no control underneath can swallow the event first and nothing is listening the rest of the time.
  const filterRowRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    const onDown = (e: PointerEvent) => {
      if (!filterRowRef.current?.contains(e.target as Node)) setMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      // Consume it: with a menu open, Escape belongs to the menu, not to whatever would close the panel.
      if (e.key === "Escape") { e.stopPropagation(); setMenu(null); }
    };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [menu]);
  const [xItems, setXItems] = useState<AnnoItem[] | null>(null);
  const [xBms, setXBms] = useState<BookmarkItem[] | null>(null);
  useEffect(() => {
    if (!open) { setSource("current"); setSrcMenu(false); }
  }, [open]);
  // Following a cross-book row REPLACES the book being read, so the source that pointed at it now IS
  // "this book": snap back to the default. Without this the panel would show the read-only cross-book
  // view of the book you are now reading — no edit controls, and labelled "This book". (The label fell
  // back to "This book" because `books` excludes the current one — a control lying about its state.)
  useEffect(() => { setSource("current"); setSrcMenu(false); }, [currentBookId]);

  // Lazy: fetch the cross-book lists only when the user actually reaches for the filter, so the default
  // ("this book") path costs nothing extra. Re-read on every menu open rather than caching once — these
  // are cheap reads, and a cached list would go stale against notes added in this session.
  const loadCross = () => {
    annotationsAll().then(setXItems).catch(console.error);
    bookmarksAll().then(setXBms).catch(console.error);
  };

  // Books that HAVE something to show (notes/highlights or bookmarks), minus the one we're reading.
  const books = useMemo(() => {
    const m = new Map<string, string>();
    for (const it of xItems ?? []) if (!m.has(it.book_id)) m.set(it.book_id, it.book_title || "—");
    for (const b of xBms ?? []) if (!m.has(b.book_id)) m.set(b.book_id, b.book_title || "—");
    m.delete(currentBookId ?? "");
    return [...m].map(([id, title]) => ({ id, title }));
  }, [xItems, xBms, currentBookId]);

  const cross = source !== "current";
  const inSrc = <T extends { book_id: string }>(rows: T[]) =>
    source === "all" ? rows : rows.filter((r) => r.book_id === source);
  const xAll = useMemo(() => inSrc(xItems ?? []), [xItems, source]);
  // RAWY-205 holds here by construction: a tag-only highlight has no note body, so it can never render
  // as a blank note — it appears (correctly) under Highlights only.
  // RAWY-282 (classification): `annoIsNote` / `annoIsHighlight` are defined once in `lib/ipc.ts` and
  // shared with the library Inbox, so the two surfaces cannot disagree about what an item is.
  const xNotes = useMemo(() => xAll.filter(annoIsNote), [xAll]);
  const xHls = useMemo(() => xAll.filter(annoIsHighlight), [xAll]);
  const xMarks = useMemo(() => inSrc(xBms ?? []), [xBms, source]);

  // ── THE TAG FILTER — a second GLOBAL filter, beside the book scope ─────────────────────────────
  //
  // It belongs to the annotations view as a whole, not to one tab, so it lives here and is applied to
  // every list before the tabs ever see them. Notes and highlights BOTH carry tags — a highlight's are
  // the tags on the note attached to it (RAWY-205's empty-body anchor note exists for exactly that) —
  // so one filter is honest for both. References, replacements and bookmarks have no tag relationship
  // at all, and the control is simply not offered on their tabs.
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  useEffect(() => { if (!open) setTagFilter(null); }, [open]);

  // OPTIONS ARE THE LIBRARY'S TAGS, NOT THE SCOPE'S.
  //
  // These were derived from the annotations currently in view, on the reasoning that a menu should
  // never offer a choice that yields nothing. That was wrong, and it made the control lie: a reader
  // with tags on other books saw a short list and no way to reach the rest. The two ideas are
  // separate and must not be conflated —
  //
  //     TAG OPTIONS   = every tag that exists (the `tags` table)
  //     FILTER RESULT = annotations IN SCOPE carrying the chosen one
  //
  // — and an empty result is a legitimate answer, not a state to be prevented. `tagsList` is the same
  // command the library Inbox and the TagPicker already read, so there is one source of tags.
  const [allTags, setAllTags] = useState<string[]>([]);
  const loadTags = () => { tagsList().then((ts) => setAllTags(ts.map((x) => x.name))).catch(console.error); };
  // On open, and again whenever the annotations change — a tag can be created inline while writing a
  // note, and it must appear here without reopening the panel.
  useEffect(() => { if (open) loadTags(); }, [open, notes, highlights]);
  const tagNames = allTags;

  // The filter only goes stale if the TAG ITSELF is gone (deleted globally). It deliberately survives
  // a change of book or scope: choosing a tag, then switching to the book that has it, is exactly how
  // a reader finds their tagged passages, and clearing it there would defeat the control.
  useEffect(() => {
    if (allTags.length > 0 && !tagFilterStillValid(tagFilter, allTags)) setTagFilter(null);
  }, [allTags, tagFilter]);

  // A tag ENTITY changed under us. Tag names are never stored on an annotation — they are resolved
  // through the join — so the ROWS have to be re-read for a rename to show on their cards. And if the
  // renamed tag is the one currently filtering, the filter follows it: the reader chose that tag, and
  // renaming it is not a reason to silently drop their choice.
  const reloadAnnotations = useAnnotations((s2) => s2.load);
  const onTagsChanged = (change?: { from: string; to: string }) => {
    loadTags();
    void reloadAnnotations();
    if (change && tagFilter === change.from) setTagFilter(change.to);
  };

  const fNotes = useMemo(() => filterByTag(notes, tagFilter), [notes, tagFilter]);
  const fHls = useMemo(() => filterByTag(standaloneHighlights, tagFilter), [standaloneHighlights, tagFilter]);
  const fxNotes = useMemo(() => filterByTag(xNotes, tagFilter), [xNotes, tagFilter]);
  const fxHls = useMemo(() => filterByTag(xHls, tagFilter), [xHls, tagFilter]);

  const nNotes = cross ? fxNotes.length : fNotes.length;
  const nHls = cross ? fxHls.length : fHls.length;
  const nBms = cross ? xMarks.length : bookmarks.length;
  // REFERENCES AND REPLACEMENTS BELONG TO THE OPEN BOOK, always. Their stores are bound to it (see
  // `bind`), and a rule that rewrites this book's words has no meaning in another — so unlike the
  // three above they do not follow the cross-book source filter, and their numerals are the book's.
  const refs = useReferences((s2) => s2.refs);
  const reps = useReplacements((s2) => s2.reps);
  const counts: Record<AnnoTab, number> = {
    highlights: nHls,
    notes: nNotes,
    references: refs.length,
    replacements: reps.length,
    bookmarks: nBms,
  };

  const srcLabel =
    source === "current" ? t("panel.src.current")
    : source === "all" ? t("panel.src.all")
    : books.find((b) => b.id === source)?.title ?? t("panel.src.current");

  // A row in the CURRENT book jumps in place; another book goes through the Library's open path.
  // (Reader re-opens on `[initial.id]`, so setOpen with the SAME id would not fire — hence the split.)
  const openRow = (bookId: string, filePath: string, bookDir: string | null, cfi: string | null) => {
    if (!cfi) return;
    if (bookId === currentBookId) onJump(cfi);
    else onOpenBook?.({ id: bookId, filePath, dir: bookDir, cfi });
  };

  return (
    <aside
      className={`reader-panel ${panelDockClass("notes")}${open ? " show" : ""}`}
      dir={dir}
      aria-hidden={!open}
      inert={!open} // RAWY-288: see ChaptersPanel — keeps the closed panel out of the tab order
    >
      {/* RAWY-121 (design 2a "Segmented — quiet numerals, warm active wash"): a TWO-ROW header — a quiet
          eyebrow label + a round close ✕ on its own row, then a full-width segmented tab track — so the
          three Arabic labels + counts + close fit the 300px panel without overflowing (the old single
          row pushed the ✕ off the edge — RAWY-120/121). */}
      <div className="rp-head rp-head-anno">
        <div className="rp-eyebrow">
          <span className="rp-eyebrow-label">{t("panel.annoEyebrow")}</span>
          <button className="rp-x rp-x-round ui-close" onClick={onClose} title={t("panel.close")} aria-label={t("panel.close")}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
        {/* ONE TRACK, FIVE SEGMENTS, WRITTEN ONCE. Three hand-written buttons could be read at a
            glance; five could not, and a sixth kind of mark would have meant a fourth copy of the
            same markup. The list is the order — see `AnnoTab`. The track wraps rather than squeezing,
            which is how the settings drawer already carries its own five (`.sp-tabs`): three then
            two, each segment still wide enough for «الاستبدالات» and its numeral. */}
        <div className="rp-tabs" role="tablist">
          {CATEGORIES.map((c) => (
            <button
              key={c.key}
              role="tab"
              aria-selected={tab === c.key}
              className={`rp-tab${tab === c.key ? " on" : ""}`}
              onClick={() => setTab(c.key)}
            >
              <span className="rp-tab-label">{t(c.label)}</span>
              <span className="rp-count">{localeNum(counts[c.key], lang)}</span>
            </button>
          ))}
        </div>
      </div>

      {/* THE SOURCE FILTER BELONGS TO THE THREE KINDS THAT HAVE A CROSS-BOOK FORM. References and
          replacements are the open book's own, so showing a book chooser above them would offer a
          scope they cannot honour — it read as "this book" over a list that could never be anything
          else. Hidden there rather than disabled, because there is no choice to grey out. */}
      {tab !== "references" && tab !== "replacements" && (
      <>
      {/* RAWY-206: the source filter — the Inbox's own control (`.inbox-ctl` + `.lib-menu`), no new
          design language. It sits OUTSIDE `.rp-scroll` so it stays put while the list scrolls. */}
      <div className="rp-src" ref={filterRowRef}>
        <div className="inbox-ctl-wrap rp-src-wrap">
          <button className="inbox-ctl rp-src-ctl" onClick={() => { loadCross(); setMenu(srcMenu ? null : "src"); }}>
            {srcLabel} ▾
          </button>
          {srcMenu && (
            <div className="lib-menu inbox-menu rp-src-menu">
              <button className={source === "current" ? "active" : ""} onClick={() => { setSource("current"); setSrcMenu(false); }}>
                {t("panel.src.current")}
              </button>
              <button className={source === "all" ? "active" : ""} onClick={() => { setSource("all"); setSrcMenu(false); }}>
                {t("panel.src.all")}
              </button>
              {books.map((b) => (
                <button
                  key={b.id}
                  className={source === b.id ? "active" : ""}
                  dir={isArabicText(b.title) ? "rtl" : "ltr"}
                  onClick={() => { setSource(b.id); setSrcMenu(false); }}
                >
                  {b.title}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* THE SECOND FILTER. Same control, same menu, same row — it reads as a pair with the book
            scope because it is one: «كل الكتب» × «كل الوسوم». Offered only on the two tabs whose rows
            can carry a tag; bookmarks share this row but have no tag relationship, so showing it there
            would promise a filter that could never do anything. */}
        {(tab === "notes" || tab === "highlights") && (
          <div className="inbox-ctl-wrap rp-src-wrap">
            <button
              className={`inbox-ctl rp-src-ctl${tagFilter ? " on" : ""}`}
              onClick={() => setMenu(tagMenu ? null : "tag")}
              dir={tagFilter && isArabicText(tagFilter) ? "rtl" : undefined}
              title={tagFilter ?? t("panel.tag.all")}
            >
              {tagFilter ?? t("panel.tag.all")} ▾
            </button>
            {tagMenu && (
              <div className="lib-menu inbox-menu rp-src-menu">
                <button className={tagFilter === null ? "active" : ""} onClick={() => { setTagFilter(null); setTagMenu(false); }}>
                  {t("panel.tag.all")}
                </button>
                {tagNames.length === 0 && <button disabled>{t("panel.tag.none")}</button>}
                {tagNames.map((tg) => (
                  <button
                    key={tg}
                    className={tagFilter === tg ? "active" : ""}
                    dir={isArabicText(tg) ? "rtl" : "ltr"}
                    onClick={() => { setTagFilter(tg); setTagMenu(false); }}
                  >
                    {tg}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
      </>
      )}

      <div className="rp-scroll">
        {/* REFERENCES AND REPLACEMENTS ANSWER FIRST, whichever source is chosen. They are the open
            book's own and have no cross-book form, so letting the filter fall through to `CrossTab`
            would have shown an empty list for a book that has plenty. */}
        {tab === "references" ? (
          <ReferencesTab onJump={onJump} />
        ) : tab === "replacements" ? (
          <ReplacementsTab />
        ) : !cross ? (
          // The DEFAULT: unchanged from before RAWY-206 — live store data, fully editable.
          tab === "notes" ? (
            <NotesTab highlights={highlights} notes={fNotes} onJump={onJump} tagActive={tagFilter} onTagsChanged={onTagsChanged} />
          ) : tab === "highlights" ? (
            <HighlightsTab highlights={fHls} onJump={onJump} tagActive={tagFilter} />
          ) : (
            <BookmarksTab bookmarks={bookmarks} onJump={onJump} />
          )
        ) : (
          <CrossTab tab={tab} notes={fxNotes} highlights={fxHls} marks={xMarks} loaded={!!xItems} onOpen={openRow} tagActive={tagFilter} />
        )}
      </div>
    </aside>
  );
}

/**
 * THE REFERENCES THIS BOOK CARRIES.
 *
 * Built from `.rp-item` exactly as Notes and Highlights are — the phrase reads as the passage, the
 * note beneath it as the writing, and one quiet destructive control sits in the head row. Nothing new
 * was drawn for it, which is why it does not look like an addition.
 */
function ReferencesTab({ onJump }: { onJump: (cfi: string) => void }) {
  const { t } = useI18n();
  const refs = useReferences((s) => s.refs);
  const remove = useReferences((s) => s.remove);
  const sel = useListSelection(refs.map((r) => r.id));
  void onJump; // a reference marks words, not a locator — there is nothing to jump to yet

  if (refs.length === 0) return <div className="rp-empty">{t("panel.noReferences")}</div>;
  return (
    <>
      <SelectionBar
        sel={sel}
        total={refs.length}
        actions={[{
          key: "delete",
          icon: "trash" as const,
          label: t("select.delete"),
          danger: true,
          // The SAME removal one row uses, run over the chosen ones — there is no second delete path
          // that could behave differently from the one a reader already trusts.
          run: () => { for (const id of sel.selected) void remove(id); sel.exit(); },
        }]}
      />
      {refs.map((r) => (
        <div
          key={r.id}
          className={`rp-item plain${sel.has(r.id) ? " sel-on" : ""}`}
          {...rowSelectProps(sel, r.id)}
        >
          <div className="rp-item-head">
            {sel.on && <SelectionBox on={sel.has(r.id)} onToggle={() => sel.toggle(r.id)} label={r.phrase} />}
            <span className="rp-chapter" dir="auto">{r.phrase}</span>
            {!sel.on && (
              <button className="rp-mini danger" onClick={() => void remove(r.id)}>{t("ref.delete")}</button>
            )}
          </div>
          <div className={`rp-excerpt${isArabicText(r.note) ? " ar" : ""}`} dir="auto">{r.note}</div>
        </div>
      ))}
    </>
  );
}

/**
 * THE REPLACEMENTS THIS BOOK CARRIES, each with the switch that is its whole point.
 *
 * The switch writes to `useReplacements().setEnabled`, which is the SAME state the rule was created
 * with and the same one the library's own list uses: it persists through `rep_set_enabled` and then
 * re-pushes the enabled set at the renderer, so the page changes because the rule left the set — not
 * because a second flag somewhere said to ignore it. There is one truth about whether a replacement
 * is on, and this control moves it.
 *
 * The switch itself is the reader's own `.rs-switch`/`.rs-knob`, the part every reading setting uses,
 * which also means its knob travels the correct way in Arabic without this file knowing the direction.
 */
function ReplacementsTab() {
  const { t } = useI18n();
  const reps = useReplacements((s) => s.reps);
  const setEnabled = useReplacements((s) => s.setEnabled);
  const remove = useReplacements((s) => s.remove);
  const sel = useListSelection(reps.map((r) => r.id));

  if (reps.length === 0) return <div className="rp-empty">{t("panel.noReplacements")}</div>;
  return (
    <>
      <SelectionBar
        sel={sel}
        total={reps.length}
        actions={[{
          key: "delete",
          icon: "trash" as const,
          label: t("select.delete"),
          danger: true,
          run: () => { for (const id of sel.selected) void remove(id); sel.exit(); },
        }]}
      />
      {reps.map((r) => (
        <div
          key={r.id}
          className={`rp-item plain rep-item${r.enabled ? "" : " off"}${sel.has(r.id) ? " sel-on" : ""}`}
          {...rowSelectProps(sel, r.id)}
        >
          <div className="rp-item-head">
            {sel.on && <SelectionBox on={sel.has(r.id)} onToggle={() => sel.toggle(r.id)} label={r.phrase} />}
            {/* The state is announced only when it is OFF. A row that is doing its job needs no
                badge; a row that is switched off is the one a reader has to be told about, which is
                the same rule the library's list follows. */}
            <span className="rp-chapter">{r.enabled ? "" : t("rep.off")}</span>
            {!sel.on && (
              <button className="rp-mini danger" onClick={() => void remove(r.id)}>{t("rep.delete")}</button>
            )}
          </div>
          {/* THE RULE, NAMED RATHER THAN ARROWED. An arrow has to point somewhere, and this row can
              hold Arabic on one side and Latin on the other, so no single direction is right for it —
              the first attempt drew a glyph keyed to the PANEL's direction and pointed the wrong way
              the moment a row read the other way. The two sides are labelled instead, with the words
              the editor already uses, and a label cannot point wrongly. */}
          <div className="rep-rule">
            <span className="rep-key">{t("rep.fromLabel")}</span>
            <span className={`rep-was${isArabicText(r.phrase) ? " ar" : ""}`} dir="auto">{r.phrase}</span>
            <span className="rep-key">{t("rep.toLabel")}</span>
            <span className={`rep-now${isArabicText(r.replacement) ? " ar" : ""}`} dir="auto">{r.replacement}</span>
          </div>
          {!sel.on && (
          <button
            className="rs-toggle-row rep-switch-row"
            role="switch"
            aria-checked={r.enabled}
            aria-label={t("rep.toggle")}
            onClick={() => void setEnabled(r.id, !r.enabled)}
          >
            <span className="rs-toggle-text"><span className="rs-toggle-label">{t("rep.toggle")}</span></span>
            <span className={`rs-switch${r.enabled ? " on" : ""}`} aria-hidden><span className="rs-knob" /></span>
          </button>
          )}
        </div>
      ))}
    </>
  );
}

// RAWY-206: the cross-book (other book / all books) list — READ-ONLY by design: editing a row needs that
// book's store, and only the open book has one. So the rows carry NO edit/delete controls, and the hint
// says why. Each row shows BOOK · CHAPTER above the text, and opens its own book at its locator.
function CrossTab({
  tab,
  notes,
  highlights,
  marks,
  loaded,
  onOpen,
  tagActive,
}: {
  tab: AnnoTab;
  notes: AnnoItem[];
  highlights: AnnoItem[];
  marks: BookmarkItem[];
  loaded: boolean;
  onOpen: (bookId: string, filePath: string, bookDir: string | null, cfi: string | null) => void;
  /** The tag the sidebar is filtering by, so an empty list can say WHY it is empty. */
  tagActive: string | null;
}) {
  const { t, lang } = useI18n();
  const hl = useHl();
  const { shape, color } = useBookmarkStyle();
  if (!loaded) return null;

  const rows =
    tab === "notes" ? notes : tab === "highlights" ? highlights : [];
  // A tag that matches nothing IN THIS SCOPE is a real answer, not an error — say that, rather than
  // «no notes yet», which would tell the reader to write one they may already have in another book.
  // Bookmarks carry no tags, so their message never changes.
  const empty =
    tab === "bookmarks" ? t("panel.noBookmarks")
    : tagActive ? t("panel.tag.empty")
    : tab === "notes" ? t("panel.noNotes") : t("panel.noHighlights");

  return (
    <>
      <div className="rp-hint">{t("panel.src.readonly")}</div>
      {tab !== "bookmarks" && rows.length === 0 && <div className="rp-empty">{empty}</div>}
      {tab !== "bookmarks" &&
        rows.map((it) => (
          <div
            key={`${it.kind}-${it.id}`}
            className="rp-item rp-x-item"
            style={{ "--swatch": colorValue(it.color, hl) } as CSSProperties}
            onClick={() => onOpen(it.book_id, it.file_path, it.book_dir, it.cfi)}
            role="button"
            tabIndex={0}
          >
            <div className="rp-x-src" dir="auto">
              {[it.book_title || "—", it.chapter_label].filter(Boolean).join(" · ")}
            </div>
            {/* RAWY-282: the title heads the card here too, so the cross-book list reads the same as
                the in-book one. Absent title = exactly the previous rendering. */}
            {(it.note_title ?? "").trim() !== "" && (
              <div className="rp-note-title" dir="auto">{it.note_title}</div>
            )}
            {/* `text` is the note BODY for a margin note, and the excerpt for a highlight. */}
            <div className="rp-x-text" dir="auto">{it.text}</div>
            {it.kind === "highlight" && (it.note ?? "").trim() !== "" && (
              <div className={`rp-note-body${isArabicText(it.note) ? " ar" : ""}`} dir="auto">{it.note}</div>
            )}
            {it.tags.length > 0 && (
              <div className="rp-x-tags">
                {it.tags.map((tg) => <span key={tg} className="inbox-tag">{tg}</span>)}
              </div>
            )}
          </div>
        ))}

      {tab === "bookmarks" && marks.length === 0 && <div className="rp-empty">{empty}</div>}
      {tab === "bookmarks" &&
        marks.map((b) => (
          <div
            key={b.id}
            className="rp-item bm-item rp-x-item"
            onClick={() => onOpen(b.book_id, b.file_path, b.book_dir, b.cfi)}
            role="button"
            tabIndex={0}
          >
            <span className="bm-item-mark" aria-hidden>
              <BookmarkShape shape={shape} color={color} h={30} />
            </span>
            <span className="bm-item-label">
              <span className="rp-x-src" dir="auto">{b.book_title || "—"}</span>
              <span className="rp-chapter" dir="auto">
                {b.chapter_label || t("reader.chapterFallback")}
                <span className="bm-item-pct">{localeNum(Math.round((b.fraction ?? 0) * 100), lang)}%</span>
              </span>
            </span>
          </div>
        ))}
    </>
  );
}

function BookmarksTab({ bookmarks, onJump }: { bookmarks: BookmarkRow[]; onJump: (cfi: string) => void }) {
  const { t, lang } = useI18n();
  const { shape, color } = useBookmarkStyle();
  const remove = useBookmarks((s) => s.remove);
  const sel = useListSelection(bookmarks.map((b) => b.id));
  return (
    <>
      <SelectionBar
        sel={sel}
        total={bookmarks.length}
        actions={[{
          key: "delete",
          icon: "trash" as const,
          label: t("select.delete"),
          danger: true,
          run: () => { for (const id of sel.selected) remove(id); sel.exit(); },
        }]}
      />
      {bookmarks.length === 0 && <div className="rp-empty">{t("panel.noBookmarks")}</div>}
      {bookmarks.map((b) => (
        <div
          key={b.id}
          className={`rp-item bm-item${sel.has(b.id) ? " sel-on" : ""}`}
          {...rowSelectProps(sel, b.id)}
        >
          {sel.on && (
            <SelectionBox
              on={sel.has(b.id)}
              onToggle={() => sel.toggle(b.id)}
              label={b.chapter_label || t("reader.chapterFallback")}
            />
          )}
          <span className="bm-item-mark" aria-hidden>
            <BookmarkShape shape={shape} color={color} h={30} />
          </span>
          <span className="rp-chapter bm-item-label" dir="auto" onClick={() => onJump(b.cfi)} role="button" tabIndex={0}>
            {b.chapter_label || t("reader.chapterFallback")}
            <span className="bm-item-pct">{localeNum(Math.round((b.fraction ?? 0) * 100), lang)}%</span>
          </span>
          {!sel.on && (
            <button className="rp-mini danger" onClick={() => remove(b.id)}>{t("note.delete")}</button>
          )}
        </div>
      ))}
    </>
  );
}

function NotesTab({ highlights, notes, onJump, tagActive, onTagsChanged }: { highlights: HighlightRow[]; notes: NoteRow[]; onJump: (cfi: string) => void; tagActive: string | null; onTagsChanged: (change?: { from: string; to: string }) => void }) {
  const { t } = useI18n();
  const hl = useHl();
  const updateNote = useAnnotations((s) => s.updateNote);
  const deleteNote = useAnnotations((s) => s.deleteNote);

  // The tag filter is the PANEL's, not this tab's — `notes` arrives already filtered by it, so this
  // list renders whatever it is handed and has no filtering opinion of its own.
  const sel = useListSelection(notes.map((n) => n.id));
  const addMarginNote = useAnnotations((s) => s.addMarginNote);
  const [editId, setEditId] = useState<string | null>(null);
  // The tag ids of the note being edited. Ids, not names, because that is what `TagPicker` selects and
  // what `noteTagsSet` writes; the card shows names because that is what a reader reads.
  const [editTagIds, setEditTagIds] = useState<string[]>([]);
  const reloadNotes = useAnnotations((s) => s.load);
  const [draft, setDraft] = useState("");
  const [draftTitle, setDraftTitle] = useState(""); // RAWY-282
  const [composing, setComposing] = useState(false);
  const [marginDraft, setMarginDraft] = useState("");
  const [marginTitle, setMarginTitle] = useState(""); // RAWY-282
  const [marginColor, setMarginColor] = useState<HighlightColor>("amber");

  const locate = (n: NoteRow): string | null =>
    n.cfi ?? highlights.find((h) => h.id === n.highlight_id)?.cfi ?? null;

  const addMargin = async () => {
    const cfi = useReader.getState().cfi;
    const chapter = useReader.getState().chapterLabel;
    // RAWY-282: a title alone is enough to create the note, so the guard accepts either field.
    if (!cfi || (!marginDraft.trim() && !marginTitle.trim())) {
      setComposing(false);
      setMarginDraft("");
      setMarginTitle("");
      return;
    }
    await addMarginNote(cfi, marginColor, marginDraft, chapter, marginTitle);
    setComposing(false);
    setMarginDraft("");
    setMarginTitle("");
  };

  return (
    <>
      <div className="rp-toolrow">
        {composing ? (
          <div className="rp-compose">
            {/* RAWY-282: title first, optional. A plain single-line input, so Enter is free to submit
                nothing and the field can never grow the card. */}
            <input
              className="rp-title-input"
              value={marginTitle}
              onChange={(e) => setMarginTitle(e.target.value)}
              placeholder={t("note.titlePlaceholder")}
              aria-label={t("note.title")}
              dir="auto"
              maxLength={NOTE_TITLE_MAX}
            />
            <textarea
              className={`rp-textarea${isArabicText(marginDraft) ? " ar" : ""}`}
              autoFocus
              value={marginDraft}
              onChange={(e) => setMarginDraft(e.target.value)}
              placeholder={t("hl.addNote")}
              dir="auto"
              rows={3}
            />
            <ColorRow active={marginColor} onPick={setMarginColor} />
            <div className="rp-compose-foot">
              <button className="rp-mini" onClick={() => { setComposing(false); setMarginDraft(""); setMarginTitle(""); }}>{t("note.cancel")}</button>
              <button className="rp-mini primary" onClick={addMargin}>{t("hl.save")}</button>
            </div>
          </div>
        ) : (
          <button className="rp-add" onClick={() => setComposing(true)}>＋ {t("panel.addMarginNote")}</button>
        )}
      </div>

      {/* THE TAG FILTER USED TO BE A CHIP ROW HERE. It moved to the panel header, beside the book
          scope, once it became a filter for the annotations view as a whole rather than for this one
          list — two controls doing the same job in one panel is worse than either alone. The tags
          themselves still show on each card below, where they identify the note rather than filter it. */}

      <SelectionBar
        sel={sel}
        total={notes.length}
        actions={[{
          key: "delete",
          icon: "trash" as const,
          label: t("select.delete"),
          danger: true,
          run: () => { for (const id of sel.selected) deleteNote(id); sel.exit(); },
        }]}
      />

      {notes.length === 0 && <div className="rp-empty">{tagActive ? t("panel.tag.empty") : t("panel.noNotes")}</div>}

      {notes.map((n) => {
        const target = locate(n);
        const editing = editId === n.id;
        return (
          <div
            key={n.id}
            className={`rp-item note-item${sel.has(n.id) ? " sel-on" : ""}`}
            style={{ "--swatch": colorValue(n.color, hl) } as CSSProperties}
            {...rowSelectProps(sel, n.id)}
          >
            <div className="rp-item-head">
              {sel.on && (
                <SelectionBox
                  on={sel.has(n.id)}
                  onToggle={() => sel.toggle(n.id)}
                  label={n.title || n.chapter_label || t("panel.marginNote")}
                />
              )}
              <span className="rp-chapter" dir="auto" onClick={() => target && onJump(target)} role="button" tabIndex={0}>
                {n.chapter_label || (n.highlight_id ? "" : t("panel.marginNote"))}
              </span>
              {!sel.on && (
              <div className="rp-item-actions">
                <button
                  className="rp-mini"
                  onClick={() => {
                    setEditId(n.id);
                    setDraft(n.body ?? "");
                    setDraftTitle(n.title ?? "");
                    // The row carries tag NAMES; the picker needs ids, so read them for this one note.
                    setEditTagIds([]);
                    noteTagsFor(n.id).then((ts) => setEditTagIds(ts.map((x) => x.id))).catch(console.error);
                  }}
                >{t("note.edit")}</button>
                <button className="rp-mini danger" onClick={() => deleteNote(n.id)}>{t("note.delete")}</button>
              </div>
              )}
            </div>
            {editing ? (
              <div className="rp-compose">
                <input
                  className="rp-title-input"
                  value={draftTitle}
                  onChange={(e) => setDraftTitle(e.target.value)}
                  placeholder={t("note.titlePlaceholder")}
                  aria-label={t("note.title")}
                  dir="auto"
                  maxLength={NOTE_TITLE_MAX}
                />
                <textarea className={`rp-textarea${isArabicText(draft) ? " ar" : ""}`} autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} dir="auto" rows={3} />
                {/* The SAME picker the note popover uses, so assigning and removing a tag is one
                    gesture and one component wherever a note is written. Without it a note could be
                    tagged only at the moment it was created. */}
                <div className="nec-tags">
                  <TagPicker selected={editTagIds} onChange={setEditTagIds} onTagsChanged={onTagsChanged} />
                </div>
                <div className="rp-compose-foot">
                  <button className="rp-mini" onClick={() => setEditId(null)}>{t("note.cancel")}</button>
                  <button
                    className="rp-mini primary"
                    onClick={async () => {
                      await updateNote(n.id, draft, n.color, draftTitle);
                      await noteTagsSet(n.id, editTagIds);
                      // `updateNote` refreshed the row BEFORE the links were written, so re-read the
                      // book's notes: without this the card and the filter would both show the old tags.
                      await reloadNotes();
                      setEditId(null);
                    }}
                  >{t("hl.save")}</button>
                </div>
              </div>
            ) : (
              // RAWY-282: title (emphasised) above the body preview. With no title this renders exactly
              // what it always did — a single `.rp-note-body` — so untitled notes are unchanged.
              <div className="rp-note-text" onClick={() => target && onJump(target)}>
                {(n.title ?? "").trim() !== "" && (
                  <div className="rp-note-title" dir="auto">{n.title}</div>
                )}
                {(n.body ?? "").trim() !== "" && (
                  <div className={`rp-note-body${isArabicText(n.body) ? " ar" : ""}`} dir="auto">{n.body}</div>
                )}
                {/* The note's own tags, in the same chip the cross-book list has always used, so one
                    note looks the same wherever it is read. INDICATORS, not controls: filtering is the
                    header's single job, and a second way to set the same state would be one too many. */}
                {n.tags.length > 0 && (
                  <div className="rp-note-tags">
                    {n.tags.map((tg) => <span key={tg} className="inbox-tag" dir="auto">{tg}</span>)}
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}

function HighlightsTab({ highlights, onJump, tagActive }: { highlights: HighlightRow[]; onJump: (cfi: string) => void; tagActive: string | null }) {
  const { t } = useI18n();
  const hl = useHl();
  const setColor = useAnnotations((s) => s.setColor);
  const removeHighlight = useAnnotations((s) => s.removeHighlight);
  const sel = useListSelection(highlights.map((h) => h.id));

  return (
    <>
      <SelectionBar
        sel={sel}
        total={highlights.length}
        actions={[{
          key: "delete",
          icon: "trash" as const,
          label: t("select.delete"),
          danger: true,
          run: () => { for (const id of sel.selected) removeHighlight(id); sel.exit(); },
        }]}
      />
      {highlights.length === 0 && <div className="rp-empty">{tagActive ? t("panel.tag.empty") : t("panel.noHighlights")}</div>}
      {highlights.map((h) => (
        <div
          key={h.id}
          className={`rp-item hi-item${sel.has(h.id) ? " sel-on" : ""}`}
          style={{ "--swatch": colorValue(h.color, hl) } as CSSProperties}
          {...rowSelectProps(sel, h.id)}
        >
          <div className="rp-item-head">
            {sel.on && (
              <SelectionBox on={sel.has(h.id)} onToggle={() => sel.toggle(h.id)} label={h.text_excerpt ?? undefined} />
            )}
            <span className="rp-chapter" dir="auto" onClick={() => onJump(h.cfi)} role="button" tabIndex={0}>{h.chapter_label}</span>
            {!sel.on && (
              <button className="rp-mini danger" onClick={() => removeHighlight(h.id)}>{t("note.delete")}</button>
            )}
          </div>
          <div
            className={`rp-excerpt${isArabicText(h.text_excerpt) ? " ar" : ""}`}
            dir="auto"
            onClick={() => onJump(h.cfi)}
          >
            {h.text_excerpt}
          </div>
          {/* A highlight's tags are the tags on the note attached to it (RAWY-205's anchor note exists
              so a body-less highlight can still be tagged). Shown as INDICATORS, in the same chip a
              note uses, so one tag looks the same wherever it appears. */}
          {h.tags.length > 0 && (
            <div className="rp-note-tags">
              {h.tags.map((tg) => <span key={tg} className="inbox-tag" dir="auto">{tg}</span>)}
            </div>
          )}
          {!sel.on && <ColorRow active={h.color} onPick={(c) => setColor(h.id, c)} />}
        </div>
      ))}
    </>
  );
}
