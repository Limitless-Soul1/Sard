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

import { useEffect, useMemo, useState, type CSSProperties } from "react";

import { useI18n } from "../../i18n";
import { THEMES, useTheme } from "../../theme";
import { useReader } from "../../reader-engine/store";
import { useAnnotations } from "./annotationsStore";
import { useBookmarks } from "./bookmarksStore";
import { BookmarkShape } from "./BookmarkShape";
import { useBookmarkStyle } from "../../lib/bookmarkStyle";
import { ColorRow } from "./AnnotationLayer";
import { colorValue } from "./highlightColors";
import { localeNum } from "../../lib/format";
import {
  annotationsAll,
  bookmarksAll,
  type AnnoItem,
  type BookmarkItem,
  type BookmarkRow,
  type HighlightColor,
  type HighlightRow,
  type NoteRow,
} from "../../lib/ipc";
import type { OpenTarget } from "./Reader"; // type-only: erased, so no runtime import cycle

export type AnnoTab = "notes" | "highlights" | "bookmarks";

const ARABIC = /[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]/;
// "current" | "all" | a book id
type Source = string;

function useHl() {
  const id = useTheme((s) => s.themeId);
  return THEMES[id].colors.highlight;
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
  const notes = useMemo(() => allNotes.filter((n) => (n.body ?? "").trim() !== ""), [allNotes]);

  // RAWY-206: source filter. Resets to "current" every time the panel opens (no persistence).
  const [source, setSource] = useState<Source>("current");
  const [srcMenu, setSrcMenu] = useState(false);
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
  const xNotes = useMemo(() => xAll.filter((it) => it.kind === "note" || (it.note ?? "").trim() !== ""), [xAll]);
  const xHls = useMemo(() => xAll.filter((it) => it.kind === "highlight"), [xAll]);
  const xMarks = useMemo(() => inSrc(xBms ?? []), [xBms, source]);

  const nNotes = cross ? xNotes.length : notes.length;
  const nHls = cross ? xHls.length : highlights.length;
  const nBms = cross ? xMarks.length : bookmarks.length;

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
      className={`reader-panel rp-trail${open ? " show" : ""}`}
      dir={dir}
      aria-hidden={!open}
      // The source menu closes on select or on any other click INSIDE the panel: `.lib-clickaway` is
      // position:fixed, and this panel is `transform`ed — which makes it the containing block — so a
      // fixed overlay could never cover the window here.
      onClick={(e) => { if (srcMenu && !(e.target as HTMLElement).closest(".rp-src-wrap")) setSrcMenu(false); }}
    >
      {/* RAWY-121 (design 2a "Segmented — quiet numerals, warm active wash"): a TWO-ROW header — a quiet
          eyebrow label + a round close ✕ on its own row, then a full-width segmented tab track — so the
          three Arabic labels + counts + close fit the 300px panel without overflowing (the old single
          row pushed the ✕ off the edge — RAWY-120/121). */}
      <div className="rp-head rp-head-anno">
        <div className="rp-eyebrow">
          <span className="rp-eyebrow-label">{t("panel.annoEyebrow")}</span>
          <button className="rp-x rp-x-round" onClick={onClose} title={t("panel.close")} aria-label={t("panel.close")}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="rp-tabs">
          <button className={`rp-tab${tab === "notes" ? " on" : ""}`} onClick={() => setTab("notes")}>
            <span className="rp-tab-label">{t("panel.notes")}</span>
            <span className="rp-count">{localeNum(nNotes, lang)}</span>
          </button>
          <button className={`rp-tab${tab === "highlights" ? " on" : ""}`} onClick={() => setTab("highlights")}>
            <span className="rp-tab-label">{t("panel.highlights")}</span>
            <span className="rp-count">{localeNum(nHls, lang)}</span>
          </button>
          <button className={`rp-tab${tab === "bookmarks" ? " on" : ""}`} onClick={() => setTab("bookmarks")}>
            <span className="rp-tab-label">{t("panel.bookmarks")}</span>
            <span className="rp-count">{localeNum(nBms, lang)}</span>
          </button>
        </div>
      </div>

      {/* RAWY-206: the source filter — the Inbox's own control (`.inbox-ctl` + `.lib-menu`), no new
          design language. It sits OUTSIDE `.rp-scroll` so it stays put while the list scrolls. */}
      <div className="rp-src">
        <div className="inbox-ctl-wrap rp-src-wrap">
          <button className="inbox-ctl rp-src-ctl" onClick={() => { loadCross(); setSrcMenu((o) => !o); }}>
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
                  dir={ARABIC.test(b.title) ? "rtl" : "ltr"}
                  onClick={() => { setSource(b.id); setSrcMenu(false); }}
                >
                  {b.title}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="rp-scroll">
        {!cross ? (
          // The DEFAULT: unchanged from before RAWY-206 — live store data, fully editable.
          tab === "notes" ? (
            <NotesTab highlights={highlights} notes={notes} onJump={onJump} />
          ) : tab === "highlights" ? (
            <HighlightsTab highlights={highlights} onJump={onJump} />
          ) : (
            <BookmarksTab bookmarks={bookmarks} onJump={onJump} />
          )
        ) : (
          <CrossTab tab={tab} notes={xNotes} highlights={xHls} marks={xMarks} loaded={!!xItems} onOpen={openRow} />
        )}
      </div>
    </aside>
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
}: {
  tab: AnnoTab;
  notes: AnnoItem[];
  highlights: AnnoItem[];
  marks: BookmarkItem[];
  loaded: boolean;
  onOpen: (bookId: string, filePath: string, bookDir: string | null, cfi: string | null) => void;
}) {
  const { t, lang } = useI18n();
  const hl = useHl();
  const { shape, color } = useBookmarkStyle();
  if (!loaded) return null;

  const rows =
    tab === "notes" ? notes : tab === "highlights" ? highlights : [];
  const empty =
    tab === "notes" ? t("panel.noNotes") : tab === "highlights" ? t("panel.noHighlights") : t("panel.noBookmarks");

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
            {/* `text` is the note BODY for a margin note, and the excerpt for a highlight. */}
            <div className="rp-x-text" dir="auto">{it.text}</div>
            {it.kind === "highlight" && (it.note ?? "").trim() !== "" && (
              <div className="rp-note-body" dir="auto">{it.note}</div>
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
  return (
    <>
      {bookmarks.length === 0 && <div className="rp-empty">{t("panel.noBookmarks")}</div>}
      {bookmarks.map((b) => (
        <div key={b.id} className="rp-item bm-item">
          <span className="bm-item-mark" aria-hidden>
            <BookmarkShape shape={shape} color={color} h={30} />
          </span>
          <span className="rp-chapter bm-item-label" dir="auto" onClick={() => onJump(b.cfi)} role="button" tabIndex={0}>
            {b.chapter_label || t("reader.chapterFallback")}
            <span className="bm-item-pct">{localeNum(Math.round((b.fraction ?? 0) * 100), lang)}%</span>
          </span>
          <button className="rp-mini danger" onClick={() => remove(b.id)}>{t("note.delete")}</button>
        </div>
      ))}
    </>
  );
}

function NotesTab({ highlights, notes, onJump }: { highlights: HighlightRow[]; notes: NoteRow[]; onJump: (cfi: string) => void }) {
  const { t } = useI18n();
  const hl = useHl();
  const updateNote = useAnnotations((s) => s.updateNote);
  const deleteNote = useAnnotations((s) => s.deleteNote);
  const addMarginNote = useAnnotations((s) => s.addMarginNote);
  const [editId, setEditId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [composing, setComposing] = useState(false);
  const [marginDraft, setMarginDraft] = useState("");
  const [marginColor, setMarginColor] = useState<HighlightColor>("amber");

  const locate = (n: NoteRow): string | null =>
    n.cfi ?? highlights.find((h) => h.id === n.highlight_id)?.cfi ?? null;

  const addMargin = async () => {
    const cfi = useReader.getState().cfi;
    const chapter = useReader.getState().chapterLabel;
    if (!cfi || !marginDraft.trim()) {
      setComposing(false);
      setMarginDraft("");
      return;
    }
    await addMarginNote(cfi, marginColor, marginDraft, chapter);
    setComposing(false);
    setMarginDraft("");
  };

  return (
    <>
      <div className="rp-toolrow">
        {composing ? (
          <div className="rp-compose">
            <textarea
              className="rp-textarea"
              autoFocus
              value={marginDraft}
              onChange={(e) => setMarginDraft(e.target.value)}
              placeholder={t("hl.addNote")}
              dir="auto"
              rows={3}
            />
            <ColorRow active={marginColor} onPick={setMarginColor} />
            <div className="rp-compose-foot">
              <button className="rp-mini" onClick={() => { setComposing(false); setMarginDraft(""); }}>{t("note.cancel")}</button>
              <button className="rp-mini primary" onClick={addMargin}>{t("hl.save")}</button>
            </div>
          </div>
        ) : (
          <button className="rp-add" onClick={() => setComposing(true)}>＋ {t("panel.addMarginNote")}</button>
        )}
      </div>

      {notes.length === 0 && <div className="rp-empty">{t("panel.noNotes")}</div>}

      {notes.map((n) => {
        const target = locate(n);
        const editing = editId === n.id;
        return (
          <div key={n.id} className="rp-item note-item" style={{ "--swatch": colorValue(n.color, hl) } as CSSProperties}>
            <div className="rp-item-head">
              <span className="rp-chapter" dir="auto" onClick={() => target && onJump(target)} role="button" tabIndex={0}>
                {n.chapter_label || (n.highlight_id ? "" : t("panel.marginNote"))}
              </span>
              <div className="rp-item-actions">
                <button className="rp-mini" onClick={() => { setEditId(n.id); setDraft(n.body ?? ""); }}>{t("note.edit")}</button>
                <button className="rp-mini danger" onClick={() => deleteNote(n.id)}>{t("note.delete")}</button>
              </div>
            </div>
            {editing ? (
              <div className="rp-compose">
                <textarea className="rp-textarea" autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} dir="auto" rows={3} />
                <div className="rp-compose-foot">
                  <button className="rp-mini" onClick={() => setEditId(null)}>{t("note.cancel")}</button>
                  <button className="rp-mini primary" onClick={async () => { await updateNote(n.id, draft, n.color); setEditId(null); }}>{t("hl.save")}</button>
                </div>
              </div>
            ) : (
              <div className="rp-note-body" dir="auto" onClick={() => target && onJump(target)}>{n.body}</div>
            )}
          </div>
        );
      })}
    </>
  );
}

function HighlightsTab({ highlights, onJump }: { highlights: HighlightRow[]; onJump: (cfi: string) => void }) {
  const { t } = useI18n();
  const hl = useHl();
  const setColor = useAnnotations((s) => s.setColor);
  const removeHighlight = useAnnotations((s) => s.removeHighlight);

  return (
    <>
      {highlights.length === 0 && <div className="rp-empty">{t("panel.noHighlights")}</div>}
      {highlights.map((h) => (
        <div key={h.id} className="rp-item hi-item" style={{ "--swatch": colorValue(h.color, hl) } as CSSProperties}>
          <div className="rp-item-head">
            <span className="rp-chapter" dir="auto" onClick={() => onJump(h.cfi)} role="button" tabIndex={0}>{h.chapter_label}</span>
            <button className="rp-mini danger" onClick={() => removeHighlight(h.id)}>{t("note.delete")}</button>
          </div>
          <div className="rp-excerpt" dir="auto" onClick={() => onJump(h.cfi)}>{h.text_excerpt}</div>
          <ColorRow active={h.color} onPick={(c) => setColor(h.id, c)} />
        </div>
      ))}
    </>
  );
}
