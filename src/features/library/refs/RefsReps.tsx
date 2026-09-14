import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { SelectionBar, SelectionBox, useListSelection } from "../../../components/listSelection";

import { useI18n } from "../../../i18n";
import { Icon } from "../../../components/Icon";
import type { OpenTarget } from "../Library";
import {
  refDelete,
  refSave,
  refsAll,
  refsForBook,
  refsRepsBooks,
  repDelete,
  repSave,
  repSetEnabled,
  repsAll,
  repsForBook,
  libraryListBooks,
  type BookRow,
  type RefRow,
  type RefsRepsBook,
  type RepRow,
} from "../../../lib/ipc";
import { foldPhrase, phraseWordCount } from "../../../lib/references";
import { localeNum, uiDateTimeFormat } from "../../../lib/format";
import { isArabicText } from "../../../lib/typography";
import { autoCoverPaint } from "../AutoCover";
import { coverSrc } from "../coverSrc";
import { matchesQuery, pluralAr, previewFor } from "./model";

import "../../../styles/refsreps.css";

// REFERENCES & REPLACEMENTS — the Library surface, built to the supplied design.
//
// TWO LEVELS, and the design is explicit about why there is no third. "With the item reduced to a
// definition, a master-detail split had nothing to hold": a reference IS a word and a note, a
// replacement IS an original and its new wording, and neither has anywhere else to go. So the shelf
// lists the books, opening one lists its items, and clicking an item turns THAT ENTRY into its own
// editor in place. One click to read, one to change, nothing opens on top of anything.
//
// WHAT THE DESIGN REMOVED, and this therefore does not draw: occurrence counts, chapter names, stored
// passages, per-item locations, and any badge saying which of the two kinds an item is. The two are
// told apart by their own grammar — a word under a twin rule, or `original ⟵ new` — which is also why
// the shelf plate can interleave them without labelling either.
/** Arabic is ALWAYS the Arabic role: Literata carries no Arabic glyphs, so a word left on the Latin
 *  role falls out of Sard's faces into a system serif. Asked of the TEXT, never of the book. */
const face = (text: string): string => (isArabicText(text) ? " ar" : "");

export function RefsReps({ onOpen }: { onOpen: (b: OpenTarget) => void }) {
  const { t, lang } = useI18n();
  const ar = lang === "ar";

  const [shelf, setShelf] = useState<RefsRepsBook[] | null>(null);
  const [books, setBooks] = useState<Map<string, BookRow>>(new Map());
  const [perBook, setPerBook] = useState<Map<string, { refs: RefRow[]; reps: RepRow[] }>>(new Map());
  const [bookId, setBookId] = useState<string | null>(null);
  const [tab, setTab] = useState<"refs" | "reps">("refs");
  const [query, setQuery] = useState("");
  const [editId, setEditId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ word: "", note: "", from: "", to: "" });
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<number>(0);

  const flash = useCallback((m: string) => {
    window.clearTimeout(toastTimer.current);
    setToast(m);
    toastTimer.current = window.setTimeout(() => setToast(null), 4400);
  }, []);
  useEffect(() => () => window.clearTimeout(toastTimer.current), []);

  /**
   * THE SHELF, IN A FIXED NUMBER OF QUERIES.
   *
   * The plate previews what the reader made in each book, so the contents are genuinely needed and no
   * data is being dropped here. What changed is how they are fetched: this asked PER BOOK — two round
   * trips a row — on the stated assumption that "a reader has tens of these, not thousands".
   *
   * MEASURED on 2,000 books carrying rules: ~3,400 IPC calls on one press, 1,121ms of the main thread
   * inside `fetch`, and a page that could not be used while it ran. The assumption was reasonable and
   * simply is not true of a large library, so the shape had to change rather than the number.
   *
   * Four calls now, whatever the size. The rows arrive ordered by book and then in the per-book
   * order, so grouping them here produces exactly what the per-book calls produced, row for row.
   */
  const reload = useCallback(async () => {
    const [rows, all, refs, reps] = await Promise.all([
      refsRepsBooks().catch(() => [] as RefsRepsBook[]),
      libraryListBooks({ sort: "title", order: "asc" }).catch(() => [] as BookRow[]),
      refsAll().catch(() => [] as RefRow[]),
      repsAll().catch(() => [] as RepRow[]),
    ]);
    setShelf(rows);
    setBooks(new Map(all.map((b) => [b.id, b])));
    const by = new Map<string, { refs: RefRow[]; reps: RepRow[] }>();
    // Every listed book gets an entry even when one side is empty, so a caller reading
    // `perBook.get(id)` sees the same shape it always did.
    for (const r of rows) by.set(r.id, { refs: [], reps: [] });
    for (const r of refs) (by.get(r.book_id) ?? by.set(r.book_id, { refs: [], reps: [] }).get(r.book_id)!).refs.push(r);
    for (const p of reps) (by.get(p.book_id) ?? by.set(p.book_id, { refs: [], reps: [] }).get(p.book_id)!).reps.push(p);
    setPerBook(by);
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  const current = bookId ? perBook.get(bookId) : undefined;
  const currentBook = bookId ? books.get(bookId) : undefined;
  const title = currentBook?.title ?? "";

  const visible = useMemo(() => {
    if (!shelf) return [];
    const rows = shelf.filter((r) => {
      const c = perBook.get(r.id);
      return matchesQuery(foldPhrase, query, c?.refs ?? [], c?.reps ?? [], books.get(r.id)?.title ?? "");
    });
    return rows; // the backend already returns most-recently-touched first
  }, [shelf, perBook, books, query]);

  // THE SEARCH REACHES INSIDE A BOOK TOO. The design says the field searches reference words, their
  // notes and replacements "across all your books" and gives the in-book miss its own wording, so
  // filtering only the shelf left a query showing every item of the book it had just narrowed to.
  const shown = useMemo(() => {
    const f = foldPhrase(query);
    if (!current) return { refs: [] as RefRow[], reps: [] as RepRow[] };
    if (!f) return current;
    return {
      refs: current.refs.filter((r) => foldPhrase(r.phrase).includes(f) || foldPhrase(r.note).includes(f)),
      reps: current.reps.filter((r) => foldPhrase(r.phrase).includes(f) || foldPhrase(r.replacement).includes(f)),
    };
  }, [current, query]);

  // CHOOSING SEVERAL. What "all" means is the tab that is forward AND what the search has left —
  // never the book's totals, which is what the tab numerals say and deliberately do not narrow.
  const visibleIds = (tab === "refs" ? shown.refs : shown.reps).map((x) => x.id);
  const sel = useListSelection(visibleIds);

  /** The section's own deletion, run over the chosen rows, then the book is read back. */
  const deleteChosen = async () => {
    for (const id of sel.selected) {
      await (tab === "refs" ? refDelete(id) : repDelete(id)).catch(() => null);
    }
    if (bookId) await refreshBook(bookId);
    sel.exit();
  };

  // The TAB COUNTS stay the book's totals: the design calls them navigational, and a count that moved
  // with the search would stop telling the reader what the other tab holds.
  const refsCount = current?.refs.length ?? 0;
  const repsCount = current?.reps.length ?? 0;
  const hasQuery = query.trim().length > 0;

  // ZERO IS A WORD, NOT A COUNT. «٠ مرجعًا» is what a formatter says; «لا مراجع» is what the design
  // says, and it is what a reader would say.
  /** Every digit this surface renders goes through the numbering policy, in both languages. */
  const fmtNum = (n: number) => localeNum(n, lang);

  const num = (n: number) =>
    n === 0
      ? t("rr.noRefs")
      : ar
        ? pluralAr(n, { one: t("rr.refOne"), two: t("rr.refTwo"), few: t("rr.refFew"), many: t("rr.refMany") }, fmtNum)
        : `${fmtNum(n)} ${n === 1 ? t("rr.refOne") : t("rr.refFew")}`;
  const numReps = (n: number) =>
    n === 0
      ? t("rr.noReps")
      : ar
        ? pluralAr(n, { one: t("rr.repOne"), two: t("rr.repTwo"), few: t("rr.repFew"), many: t("rr.repMany") }, fmtNum)
        : `${fmtNum(n)} ${n === 1 ? t("rr.repOne") : t("rr.repFew")}`;

  const resetDraft = () => { setDraft({ word: "", note: "", from: "", to: "" }); setEditId(null); setConfirmId(null); setAdding(false); };

  const enter = (id: string) => {
    setBookId(id);
    setTab((perBook.get(id)?.refs.length ?? 0) > 0 ? "refs" : "reps");
    resetDraft();
    setQuery("");
  };

  // ---- mutations. Every one re-reads the affected book so the surface and the DB never disagree ----
  const refreshBook = async (id: string) => {
    const [refs, reps] = await Promise.all([
      refsForBook(id).catch(() => [] as RefRow[]),
      repsForBook(id).catch(() => [] as RepRow[]),
    ]);
    setPerBook((m) => new Map(m).set(id, { refs, reps }));
    setShelf(await refsRepsBooks().catch(() => shelf ?? []));
  };

  const saveRef = async (row: RefRow) => {
    if (!bookId) return;
    await refSave(bookId, draft.word.trim(), foldPhrase(draft.word), phraseWordCount(draft.word), draft.note.trim())
      .catch(() => null);
    await refreshBook(bookId);
    resetDraft();
    void row;
  };
  const saveRep = async () => {
    if (!bookId) return;
    const from = draft.from.trim();
    const to = draft.to.trim();
    if (!from || !to) return;
    await repSave(bookId, from, foldPhrase(from), to, phraseWordCount(from)).catch(() => null);
    await refreshBook(bookId);
    resetDraft();
  };
  const toggleRep = async (r: RepRow) => {
    await repSetEnabled(r.id, !r.enabled).catch(() => null);
    if (bookId) await refreshBook(bookId);
    flash(r.enabled ? t("rep.offToast") : t("rep.onToast", { title }));
  };

  if (!shelf) return null; // the section draws nothing while its own IPC is in flight

  const inBook = !!bookId && !!current;
  const onReps = inBook && tab === "reps";

  return (
    <div className="rr" dir={ar ? "rtl" : "ltr"}>
      {/* ---- header: the book is stated ONCE, small and permanent, per the design ---- */}
      <div className="rr-head">
        {/* BACK, DRAWN NOT TYPED. It was a «→» glyph set in the UI face inside a 34px box: the arrow was
            whatever that font happened to draw, at text weight, in a hit area smaller than the header
            beside it. It is now a chevron from Sard's own set in a 44px control, and the chevron flips
            with the language rather than the string. */}
        {inBook && (
          <button
            className="rr-back"
            onClick={() => { setBookId(null); resetDraft(); }}
            aria-label={t("rr.allBooks")}
            title={t("rr.allBooks")}
          >
            <Icon name={ar ? "caretRight" : "caretLeft"} size="md" />
          </button>
        )}
        <div className="rr-chip">
          {inBook && <CoverChip book={currentBook} />}
          <div className="rr-chip-txt">
            <span className={`rr-chip-title${face(inBook ? title : t("lib.nav.refs"))}`} dir="auto">
              {inBook ? title : t("lib.nav.refs")}
            </span>
            <span className="rr-chip-meta">
              {inBook
                ? null
                : visible.length
                  ? (ar
                      ? `${pluralAr(visible.length, { one: t("rr.bookOne"), two: t("rr.bookTwo"), few: t("rr.bookFew"), many: t("rr.bookMany") }, fmtNum)}`
                      : `${fmtNum(visible.length)} ${visible.length === 1 ? t("rr.bookOne") : t("rr.bookFew")}`)
                  : t("rr.nothingYet")}
            </span>
            {inBook && (
              /* THE SEPARATOR IS A DOT ELEMENT, not a «·» character. Set between an Arabic word and a
                 Latin digit it read as a zero — «5 استبدالات» looked like «50». The design uses a drawn
                 dot here for the same reason, and the plate already did. */
              <span className="rr-chip-meta">
                <span>{num(refsCount)}</span>
                <span className="rr-dot" aria-hidden />
                <span>{numReps(repsCount)}</span>
              </span>
            )}
          </div>
        </div>
      </div>

      {/* ---- toolbar ---- */}
      <div className="rr-tools">
        <div className="rr-search">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" aria-hidden>
            <circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" />
          </svg>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("rr.searchPlaceholder")}
            aria-label={t("rr.search")}
          />
          {query && <button className="rr-clear" onClick={() => setQuery("")} aria-label={t("rr.clear")}>✕</button>}
        </div>
        {inBook && (
          <div className="rr-tabs">
            {/* The two marks are drawn in Sard's `nav` family, at the size that family is read at —
                see the note on their drawings for why the smaller `mark` set could not carry a tab.
                Both take `currentColor`, so active and inactive ink reach them with no rule here. */}
            <button className={`rr-tab${tab === "refs" ? " on" : ""}`} onClick={() => { setTab("refs"); resetDraft(); sel.exit(); }}>
              <Icon name="navReferences" size="md" />
              <span>{t("rr.tabRefs")}</span><span className="rr-tab-n">{fmtNum(refsCount)}</span>
            </button>
            <button className={`rr-tab${tab === "reps" ? " on" : ""}`} onClick={() => { setTab("reps"); resetDraft(); sel.exit(); }}>
              <Icon name="navReplacements" size="md" />
              <span>{t("rr.tabReps")}</span><span className="rr-tab-n">{fmtNum(repsCount)}</span>
            </button>
          </div>
        )}
        {/* THE ACTION BELONGS TO THE TAB, so it stands beside it rather than across the bar. It only
            exists on the replacements tab — there is no "new reference": a reference is born on the
            page, from a selection, which is what the empty state says in as many words. */}
        {onReps && (
          <button className="rr-primary" onClick={() => { resetDraft(); setAdding(true); }}>
            {t("rep.new")}
          </button>
        )}
        <span className="rr-spacer" />
        {inBook && (
          <SelectionBar
            sel={sel}
            total={visibleIds.length}
            actions={[{
              key: "delete",
              icon: "trash" as const,
              label: t("rep.delete"),
              confirm: t("rep.deleteConfirm"),
              danger: true,
              run: () => void deleteChosen(),
            }]}
          />
        )}
      </div>

      {/* ---- level 1: the shelf ---- */}
      {!inBook && (
        <div className="rr-scroll">
          <div className="rr-shelf">
            {visible.map((r) => {
              const b = books.get(r.id);
              const c = perBook.get(r.id);
              const preview = previewFor(c?.refs ?? [], c?.reps ?? []);
              return (
                <button key={r.id} className="rr-plate" onClick={() => enter(r.id)}>
                  <CoverPlate book={b} title={b?.title ?? ""} />
                  <span className="rr-plate-body">
                    <span className="rr-plate-title" dir="auto">{b?.title ?? ""}</span>
                    <span className="rr-plate-author" dir="auto">{b?.author ?? r.author ?? ""}</span>
                    <span className="rr-preview">
                      {preview.length === 0 && <span className={`rr-blank${face(t("rr.blankBook"))}`}>{t("rr.blankBook")}</span>}
                      {preview.map((w, i) => (
                        <span className="rr-pv" key={i}>
                          {/* A reference wears the reader's twin rule; a replacement is original ⟵ new,
                              its live side in text ink. No badge on either — the grammar is the label. */}
                          <span className={`${w.kind === "ref" ? "rr-pv-word rr-rule" : "rr-pv-word rr-muted"}${face(w.text)}`} dir="auto">
                            {w.text}
                          </span>
                          {w.kind === "rep" && (
                            <>
                              <span className={`rr-pv-arrow${w.on ? "" : " off"}`} aria-hidden>⟵</span>
                              <span className={`rr-pv-word${w.on ? "" : " rr-muted"}${face(w.to ?? "")}`} dir="auto">{w.to}</span>
                            </>
                          )}
                        </span>
                      ))}
                    </span>
                    <span className="rr-plate-foot">
                      <span>{r.refs_count ? num(r.refs_count) : t("rr.noRefs")}</span>
                      {r.reps_count > 0 && <span className="rr-dot" aria-hidden />}
                      {r.reps_count > 0 && <span>{numReps(r.reps_count)}</span>}
                      <span className="rr-spacer" />
                      <span>{whenLabel(r.touched, lang)}</span>
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
          {shelf.length === 0 && (
            <div className="rr-empty">
              <div className="rr-empty-h">{t("rr.emptyShelfTitle")}</div>
              <div className="rr-empty-b">{t("rr.emptyShelfBody")}</div>
              <div className="rr-empty-n">{t("rr.emptyShelfNote")}</div>
            </div>
          )}
          {shelf.length > 0 && visible.length === 0 && (
            <div className="rr-empty">
              <div className="rr-empty-h2">{t("rr.noMatch", { q: query })}</div>
              <div className="rr-empty-b2">{t("rr.searchScope")}</div>
            </div>
          )}
        </div>
      )}

      {/* ---- level 2: inside a book ---- */}
      {inBook && (
        <div className="rr-inner">
          <div className="rr-scroll">
            {adding && (
              <div className="rr-new">
                <div className="rr-new-h">{t("rep.newInBook")}</div>
                <div className="rep-row">
                  <input
                    className={`rep-input rep-from${face(draft.from)}`} value={draft.from} dir="auto"
                    onChange={(e) => setDraft({ ...draft, from: e.target.value })}
                    placeholder={t("rep.from")} aria-label={t("rep.fromLabel")}
                  />
                  <span className="rep-arrow" aria-hidden>⟵</span>
                  <input
                    className={`rep-input rep-to${face(draft.to)}`} value={draft.to} dir="auto"
                    onChange={(e) => setDraft({ ...draft, to: e.target.value })}
                    placeholder={t("rep.to")} aria-label={t("rep.toLabel")}
                  />
                </div>
                <div className="rr-new-acts">
                  <button className="rr-primary" onClick={() => void saveRep()}>{t("rep.add")}</button>
                  <button className="rr-ghost" onClick={resetDraft}>{t("rep.cancel")}</button>
                  <span className="rr-new-hint">{t("rep.scopeHint", { title })}</span>
                </div>
              </div>
            )}

            {tab === "refs" && (
              <div className="rr-defs">
                {shown.refs.map((r) =>
                  editId === r.id ? (
                    <div className="rr-def-wrap rr-edit" key={r.id}>
                      <input
                        className={`rr-edit-word${face(draft.word)}`} value={draft.word} dir="auto"
                        onChange={(e) => setDraft({ ...draft, word: e.target.value })} aria-label={t("ref.selected")}
                      />
                      <textarea
                        className="rr-edit-note" rows={2} value={draft.note} dir="auto"
                        onChange={(e) => setDraft({ ...draft, note: e.target.value })} aria-label={t("ref.note")}
                      />
                      <div className="rr-edit-acts">
                        <button className="rr-primary" onClick={() => void saveRef(r)}>{t("rep.save")}</button>
                        <button className="rr-ghost" onClick={resetDraft}>{t("rep.cancel")}</button>
                        <span className="rr-spacer" />
                        {confirmId === r.id ? (
                          <>
                            <button className="rr-danger" onClick={async () => { await refDelete(r.id).catch(() => null); if (bookId) await refreshBook(bookId); resetDraft(); }}>
                              {t("rep.deleteConfirm")}
                            </button>
                            <button className="rr-ghost" onClick={() => setConfirmId(null)}>{t("rep.deleteCancel")}</button>
                          </>
                        ) : (
                          <button className="rr-del" onClick={() => setConfirmId(r.id)}>{t("rep.delete")}</button>
                        )}
                      </div>
                    </div>
                  ) : (
                    <div className={`rr-def-wrap${sel.has(r.id) ? " sel-on" : ""}`} key={r.id}>
                    {sel.on && (
                      <SelectionBox on={sel.has(r.id)} onToggle={() => sel.toggle(r.id)} label={r.phrase} />
                    )}
                    <button
                      className="rr-def"
                      aria-pressed={sel.on ? sel.has(r.id) : undefined}
                      // While the mode is on the row CHOOSES; opening it for editing is what it
                      // does the rest of the time, and the two must never be the same press.
                      onClick={() => {
                        if (sel.on) { sel.toggle(r.id); return; }
                        setDraft({ word: r.phrase, note: r.note, from: "", to: "" }); setEditId(r.id); setConfirmId(null); setAdding(false);
                      }}
                    >
                      <span className={`rr-def-word rr-rule${face(r.phrase)}`} dir="auto">{r.phrase}</span>
                      <span className="rr-def-note" dir="auto">{r.note}</span>
                    </button>
                    </div>
                  ),
                )}
              </div>
            )}

            {tab === "reps" && (
              <div className="rr-rules">
                {shown.reps.map((p) =>
                  editId === p.id ? (
                    <div className="rr-edit" key={p.id}>
                      <div className="rep-row">
                        <input
                          className={`rep-input rep-from${face(draft.from)}`} value={draft.from} dir="auto"
                          onChange={(e) => setDraft({ ...draft, from: e.target.value })} aria-label={t("rep.fromLabel")}
                        />
                        <span className="rep-arrow" aria-hidden>⟵</span>
                        <input
                          className={`rep-input rep-to${face(draft.to)}`} value={draft.to} dir="auto"
                          onChange={(e) => setDraft({ ...draft, to: e.target.value })} aria-label={t("rep.toLabel")}
                        />
                      </div>
                      <div className="rr-edit-acts">
                        <button className="rr-primary" onClick={() => void saveRep()}>{t("rep.save")}</button>
                        <button className="rr-ghost" onClick={resetDraft}>{t("rep.cancel")}</button>
                        <span className="rr-spacer" />
                        {confirmId === p.id ? (
                          <>
                            <button className="rr-danger" onClick={async () => { await repDelete(p.id).catch(() => null); if (bookId) await refreshBook(bookId); resetDraft(); }}>
                              {t("rep.deleteConfirm")}
                            </button>
                            <button className="rr-ghost" onClick={() => setConfirmId(null)}>{t("rep.deleteCancel")}</button>
                          </>
                        ) : (
                          <button className="rr-del" onClick={() => setConfirmId(p.id)}>{t("rep.delete")}</button>
                        )}
                      </div>
                    </div>
                  ) : (
                    <div className={`rr-rule-row${sel.has(p.id) ? " sel-on" : ""}`} key={p.id}>
                      {sel.on && (
                        <SelectionBox on={sel.has(p.id)} onToggle={() => sel.toggle(p.id)} label={p.phrase} />
                      )}
                      <button
                        className="rr-rule-main"
                        aria-pressed={sel.on ? sel.has(p.id) : undefined}
                        onClick={() => {
                          if (sel.on) { sel.toggle(p.id); return; }
                          setDraft({ word: "", note: "", from: p.phrase, to: p.replacement }); setEditId(p.id); setConfirmId(null); setAdding(false);
                        }}
                      >
                        {/* The LIVE side carries text ink and the other is muted, so which wording is on
                            the page is readable at a glance without a word of explanation. */}
                        <span className={`rr-big${p.enabled ? " rr-muted" : ""}${face(p.phrase)}`} dir="auto">{p.phrase}</span>
                        <span className={`rr-pv-arrow${p.enabled ? "" : " off"}`} aria-hidden>⟵</span>
                        <span className={`rr-big${p.enabled ? "" : " rr-muted"}${face(p.replacement)}`} dir="auto">{p.replacement}</span>
                      </button>
                      {!p.enabled && <span className="rr-off">{t("rep.off")}</span>}
                      <button
                        className={`rr-switch${p.enabled ? " on" : ""}`}
                        role="switch"
                        aria-checked={p.enabled}
                        aria-label={t("rep.toggle")}
                        onClick={() => void toggleRep(p)}
                      >
                        <span className="rr-knob" />
                      </button>
                    </div>
                  ),
                )}
              </div>
            )}

            {((tab === "refs" && shown.refs.length === 0) || (tab === "reps" && shown.reps.length === 0 && !adding)) && (
              <div className="rr-empty">
                <div className="rr-empty-h2">
                  {hasQuery ? t("rr.emptyQueryTitle") : tab === "refs" ? t("rr.emptyRefsTitle") : t("rr.emptyRepsTitle")}
                </div>
                <div className="rr-empty-b2">
                  {hasQuery ? t("rr.emptyQueryBody") : tab === "refs" ? t("rr.emptyRefsBody") : t("rr.emptyRepsBody")}
                </div>
                {/* A miss offers no action: the way out is to clear the field, which the field itself has. */}
                {!hasQuery && (tab === "refs" ? (
                  <button className="rr-dark" onClick={() => currentBook && onOpen(bookTarget(currentBook))}>{t("rr.keepReading")}</button>
                ) : (
                  <button className="rr-primary rr-empty-cta" onClick={() => { resetDraft(); setAdding(true); }}>{t("rep.new")}</button>
                ))}
              </div>
            )}
          </div>

        </div>
      )}

      {toast && <div className="rr-toast" role="status">{toast}</div>}
    </div>
  );
}

/** A book without a cover is not a hole: it falls back to its title in the reading face at cover
 *  proportions, so the shelf and the rail stay even — the design says so in as many words. */
function CoverPlate({ book, title, small }: { book?: BookRow; title: string; small?: boolean }) {
  const src = book ? coverSrc({ cover_path: book.cover_path }) : null;
  const paint = autoCoverPaint(title);
  const ground: CSSProperties = { background: paint.bg, color: paint.ink };
  return (
    <span className={`rr-cover${small ? " sm" : ""}`} style={src ? undefined : ground}>
      {src ? <img src={src} alt="" /> : <span className={`rr-cover-fallback${face(title)}`} dir="auto">{title}</span>}
    </span>
  );
}

/** Inside a book the cover shrinks into the title chip — the context is stated once, small and permanent. */
function CoverChip({ book }: { book?: BookRow }) {
  const src = book ? coverSrc({ cover_path: book.cover_path }) : null;
  const paint = autoCoverPaint(book?.title ?? "");
  const ground: CSSProperties = { background: paint.bg, color: paint.ink };
  return <span className="rr-chip-cover" style={src ? undefined : ground}>{src && <img src={src} alt="" />}</span>;
}

/** The reader re-reads the row by id; these are the hints every launching surface passes. */
function bookTarget(b: BookRow): OpenTarget {
  return { id: b.id, filePath: b.file_path, dir: b.dir, format: b.format, title: b.title };
}

/** Through `uiDateTimeFormat`, never `toLocaleDateString` — the policy note is explicit that going
 *  direct is how the numbering rule gets bypassed, and Arabic keeps its month names either way. */
function whenLabel(touched: number | null, lang: string): string {
  if (!touched) return "";
  const d = new Date(touched * 1000);
  if (Number.isNaN(d.getTime())) return "";
  return uiDateTimeFormat(lang, { year: "numeric", month: "short", day: "numeric" }).format(d);
}
