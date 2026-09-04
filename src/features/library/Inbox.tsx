// Library → Highlights & Notes: the archive, as a card-catalogue cabinet.
//
// THE SHAPE. Two levels. The cabinet lists one shallow DRAWER per book — cover plate set into the
// face, the tally, the ink spectrum, and the newest thing marked in that book quoted with its real
// ink. Pulling a drawer opens that book's wall of slips, and the book becomes the room: the cluster
// header is gone because there is nothing left to group.
//
// WHAT MOVED, AND WHY. The flat cross-book list this replaced carried five controls in one bar:
// search, an ink row, a book menu, a tag menu and a type switch. The cabinet's own head has room for
// two of them — the search, which spans every drawer, and the order. The book menu is now the cabinet
// itself, one drawer per book, so it would be a second way to do the same thing. The other three —
// ink, tag and type — moved INSIDE the drawer, where they filter the wall of the book you are
// standing in. Nothing was dropped: every filter that existed still exists, at the level where the
// design leaves room for it.
//
// SCOPE. This file is the LIBRARY's surface only. The reader's in-book annotations panel and the
// Bookmarks shelf are deliberately untouched — they still render the `.inbox-*` rules, which is why
// this screen has its own `.arch-*` namespace and changes nothing they depend on.

import { useEffect, useMemo, useState } from "react";

import { useI18n } from "../../i18n";
import { localeDigits, uiDateTimeFormat, uiRelativeTimeFormat } from "../../lib/format";
import { resolveTheme, useTheme } from "../../theme";
import { HIGHLIGHT_SLOTS, isHex } from "../reader/highlightColors";
import {
  annoIsHighlight,
  annoIsNote,
  annotationsAll,
  libraryListBooks,
  repsForBook,
  type RepRow,
  settingsGet,
  settingsSet,
  tagsList,
  type AnnoItem,
  type BookRow,
} from "../../lib/ipc";
import type { OpenTarget } from "./Library";
import { Icon } from "../../components/Icon";
import { coverSrc } from "./coverSrc";
import { autoCoverPaint } from "./AutoCover";
import { Cabinet } from "./archive/Cabinet";
import { SlipWall } from "./archive/SlipWall";
import { SlipSheet } from "./archive/SlipSheet";
import { PhotoComposer } from "../photo/PhotoComposer";
import type { CardData } from "../photo/photo";
import {
  buildDrawers,
  clampScale,
  letterOf,
  SCALE_MAX,
  SCALE_MIN,
  SCALE_STEP,
  sortDrawers,
  type Drawer,
} from "./archive/model";
import { applyToText, type RepLite } from "../../lib/replacements";

import "../../styles/archive.css";

type TypeFilter = "all" | "highlight" | "note";

function relTime(sec: number | null, lang: string): string {
  if (!sec) return "";
  const days = Math.round((Date.now() / 1000 - sec) / 86400);
  const rtf = uiRelativeTimeFormat(lang, { numeric: "auto" });
  if (Math.abs(days) < 1) return rtf.format(0, "day");
  if (Math.abs(days) < 30) return rtf.format(-days, "day");
  return uiDateTimeFormat(lang, { month: "short", day: "numeric", year: "numeric" }).format(new Date(sec * 1000));
}

export function Inbox({ onOpen }: { onOpen: (b: OpenTarget) => void }) {
  const { t, lang } = useI18n();
  const theme = resolveTheme(useTheme((s) => s.themeId));
  const hl = theme.colors.highlight;
  const dark = theme.dark;
  // Two grounds, because two surfaces. A slip is paper; a drawer face is chrome. The ink resolver
  // carries the colour into whichever it is told about, so telling it the wrong one mixes a mark for
  // a surface it is not painted on.
  const paper = theme.colors.paperBg;
  const chrome = theme.colors.chromeBg;

  const [items, setItems] = useState<AnnoItem[]>([]);
  const [books, setBooks] = useState<BookRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [search, setSearch] = useState("");
  const [openBook, setOpenBook] = useState<string | null>(null); // which drawer is pulled open
  // A CLICK OPENS THE SLIP, NOT THE BOOK. Reading in the book is one of the four things the sheet
  // offers; it is no longer the only meaning a click can carry on this surface.
  const [sheet, setSheet] = useState<AnnoItem | null>(null);
  const [card, setCard] = useState<CardData | null>(null);
  const [reloads, setReloads] = useState(0);
  // HOW BIG THE SLIPS ARE. Persisted on the same `settings` path the Library's own view, density and
  // sort already use — the archive gets no storage mechanism of its own for one number.
  const [scale, setScale] = useState(SCALE_MIN);
  const [scaleReady, setScaleReady] = useState(false);

  // The three filters that moved inside the drawer.
  const [color, setColor] = useState<string | null>(null); // a slot, "custom", or null
  const [type, setType] = useState<TypeFilter>("all");
  const [tag, setTag] = useState<string | null>(null);
  const [tagMenu, setTagMenu] = useState(false);
  const [tagNames, setTagNames] = useState<string[]>([]);

  useEffect(() => {
    // BOTH LISTS, TOGETHER. The drawer face shows the author, the cover and when the book was last
    // opened — none of which an annotation row carries. Joining the Library's own book list here is
    // what keeps this a read-only view over data that already exists, with no backend change.
    Promise.all([
      annotationsAll().catch(() => [] as AnnoItem[]),
      libraryListBooks({ sort: "date_read", order: "desc" }).catch(() => [] as BookRow[]),
    ])
      .then(async ([rows, bs]) => {
        // WHAT THE PAGE SAYS NOW. A stored passage keeps the AUTHOR's wording — nothing here writes to
        // it — but while a replacement is in force the book reads differently, and a shelf quoting the
        // old wording would look like it had lost track of the reader's own rule. So the passage is
        // shown through the rules that are actually on, per book.
        //
        // The NOTE is deliberately left alone: it is the reader's own writing, not the author's, and a
        // rule about the book's words has no business rewriting it.
        const ids = [...new Set(rows.map((r) => r.book_id))];
        const perBook = new Map<string, RepLite[]>();
        await Promise.all(
          ids.map(async (id) => {
            const reps = await repsForBook(id).catch(() => [] as RepRow[]);
            const on = reps.filter((r) => r.enabled && r.replacement.length > 0);
            if (on.length) {
              perBook.set(id, on.map((r) => ({ id: r.id, phrase_fold: r.phrase_fold, replacement: r.replacement })));
            }
          }),
        );
        const shown = perBook.size
          ? rows.map((r) => {
              const reps = perBook.get(r.book_id);
              return reps && r.text ? { ...r, text: applyToText(r.text, reps) } : r;
            })
          : rows;
        setItems(shown);
        setBooks(bs);
      })
      .catch(console.error)
      .finally(() => setLoaded(true));
    // RAWY-204: tag options come from the tags TABLE, not from the tags on loaded notes — otherwise a
    // tag with no current links is invisible in the filter though it exists.
    tagsList().then((ts) => setTagNames(ts.map((x) => x.name))).catch(console.error);
    settingsGet("arch_scale")
      .then((v) => setScale(clampScale(v)))
      .catch(() => {})
      .finally(() => setScaleReady(true));
    // `reloads` re-runs this after the sheet writes or deletes, so the wall behind it agrees with
    // what just happened without any surface holding a second copy of the truth.
  }, [reloads]);

  const allTags = useMemo(() => {
    const s = new Set<string>(tagNames);
    for (const it of items) for (const tg of it.tags) s.add(tg);
    return [...s].sort((a, b) => a.localeCompare(b, lang, { sensitivity: "base" }));
  }, [items, tagNames, lang]);

  const q = search.trim().toLowerCase();
  const hay = (it: AnnoItem) =>
    `${it.text ?? ""} ${it.note ?? ""} ${it.note_title ?? ""} ${it.book_title ?? ""} ${it.chapter_label ?? ""} ${it.tags.join(" ")}`.toLowerCase();

  // ── level 1 · the cabinet ──────────────────────────────────────────────────────────────────────
  // The search spans every drawer: a book keeps its drawer only while something inside it still
  // matches, and the tally on the face then reports the matches rather than the whole book, so a
  // searched cabinet never claims more than it holds.
  const drawers = useMemo(() => {
    const rows = q ? items.filter((it) => hay(it).includes(q)) : items;
    return sortDrawers(buildDrawers(rows, books), lang);
  }, [items, books, q, lang]);

  // ── level 2 · inside one drawer ────────────────────────────────────────────────────────────────
  const current: Drawer | null = useMemo(
    () => (openBook ? drawers.find((d) => d.bookId === openBook) ?? null : null),
    [drawers, openBook],
  );

  const matchColor = (c: string | null) => !color || (color === "custom" ? isHex(c) : c === color);
  const wall = useMemo(() => {
    if (!current) return [];
    return current.items.filter((it) => {
      // RAWY-282: classify by CONTENT, not by the raw `kind` — a highlight carrying a note arrives as
      // `kind: "highlight"` with a body folded in. Shared predicate, unchanged by this redesign.
      if (type === "highlight" && !annoIsHighlight(it)) return false;
      if (type === "note" && !annoIsNote(it)) return false;
      if (tag && !it.tags.includes(tag)) return false;
      if (!matchColor(it.color)) return false;
      return true;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, type, tag, color]);

  /** The archive's own open path — reached from the sheet's "read in book", never from a bare click. */
  const readInBook = (it: AnnoItem) =>
    onOpen({ id: it.book_id, filePath: it.file_path, dir: it.book_dir, cfi: it.cfi });

  /** Hand the annotation to the composer the reader already uses — same component, same data shape. */
  const composeCard = (it: AnnoItem) => {
    const bk = books.find((b) => b.id === it.book_id) ?? null;
    setCard({
      quote: it.text ?? it.note ?? "",
      dir: (it.book_dir === "rtl" ? "rtl" : "ltr") as CardData["dir"],
      bookId: it.book_id,
      cfi: it.cfi ?? undefined,
      bookTitle: it.book_title ?? undefined,
      author: bk?.author ?? undefined,
      chapterLabel: it.chapter_label ?? undefined,
      date: new Date((it.created_at ?? Date.now() / 1000) * 1000),
    });
    setSheet(null);
  };

  // Written back only after the stored value has been read, so the first render cannot overwrite the
  // reader's own choice with the default.
  useEffect(() => {
    if (scaleReady) settingsSet("arch_scale", String(scale)).catch(() => {});
  }, [scale, scaleReady]);

  const num = (n: number) => localeDigits(String(n), lang);
  // ONE IS NOT PLURAL. A drawer holding a single mark read "1 highlights"; English needs the singular
  // and Arabic counts with the bare noun, so each language names its own one-form rather than having
  // a count spliced into a plural string.
  const tally = (h: number, n: number) =>
    [
      h === 1 ? t("arch.tallyH1") : h > 1 ? t("arch.tallyH", { n: num(h) }) : "",
      n === 1 ? t("arch.tallyN1") : n > 1 ? t("arch.tallyN", { n: num(n) }) : "",
    ]
      .filter(Boolean)
      .join(" · ");

  if (!loaded) return null;

  // ── the drawer, open ───────────────────────────────────────────────────────────────────────────
  if (current) {
    const src = coverSrc({ cover_path: current.coverPath });
    return (
      <div className="arch">
        <div className="arch-band">
          <button className="arch-back" onClick={() => { setOpenBook(null); setSearch(""); }}>
            <Icon name="caretLeft" size="sm" />
            {t("arch.allBooks")}
          </button>

          <span className="arch-band-plate">
            {src ? (
              <img src={src} alt="" />
            ) : (
              /* The same letter plate the cabinet uses, so a coverless book looks like itself at both
                 levels rather than showing a full generated cover squeezed into a 38px band plate. */
              <span
                className="arch-plate-letter"
                style={{ background: autoCoverPaint(current.title).bg, color: autoCoverPaint(current.title).ink }}
                aria-hidden
              >
                {letterOf(current.title)}
              </span>
            )}
          </span>

          <span className="arch-band-id">
            <span className="arch-band-title">{current.title}</span>
            <span className="arch-band-meta">{tally(current.highlights, current.notes)}</span>
          </span>

        </div>

        {/* The three filters that belong to the wall, not to the cabinet — gathered onto ONE contained
            plate that hugs them, rather than a bar ruled across the window. */}
        <div className="arch-sub on-band">
          <div className="arch-tools">
            {/* THE SEARCH BELONGS TO THIS PLATE. It used to sit alone at the far edge of the band above,
                a whole window's width from every other control, which read as an ornament rather than as
                the broadest filter of the four. It narrows the same wall the swatches and the type
                switch narrow, so it stands with them. */}
            <label className="arch-search in-tools">
              <span className="arch-search-ico" aria-hidden><Icon name="search" size="sm" /></span>
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t("arch.searchDrawer")}
              />
            </label>
          <div className="inbox-dots">
            <button
              className={`inbox-dot inbox-dot-all${color === null ? " on" : ""}`}
              onClick={() => setColor(null)}
              title={t("inbox.all")}
            >
              <Icon name="swatchAny" size="md" />
            </button>
            {HIGHLIGHT_SLOTS.map((c) => (
              <button
                key={c}
                className={`inbox-dot${color === c ? " on" : ""}`}
                style={{ background: hl[c] }}
                onClick={() => setColor(color === c ? null : c)}
                aria-label={c}
              />
            ))}
            <button
              className={`inbox-dot inbox-dot-custom${color === "custom" ? " on" : ""}`}
              onClick={() => setColor(color === "custom" ? null : "custom")}
              title={t("inbox.custom")}
            />
          </div>

          {allTags.length > 0 && (
            <div className="inbox-ctl-wrap">
              <button className="arch-sort" onClick={() => setTagMenu((o) => !o)}>
                {tag ?? t("inbox.allTags")} ▾
              </button>
              {tagMenu && (
                <>
                  <div className="lib-clickaway" onClick={() => setTagMenu(false)} />
                  <div className="lib-menu inbox-menu">
                    <button className={tag === null ? "active" : ""} onClick={() => { setTag(null); setTagMenu(false); }}>
                      {t("inbox.allTags")}
                    </button>
                    {allTags.map((tg) => (
                      <button
                        key={tg}
                        className={tag === tg ? "active" : ""}
                        onClick={() => { setTag(tg); setTagMenu(false); }}
                      >
                        {tg}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}

          <div className="inbox-seg">
            {(["all", "highlight", "note"] as TypeFilter[]).map((k) => (
              <button key={k} className={type === k ? "on" : ""} onClick={() => setType(k)}>
                {t(k === "all" ? "inbox.all" : k === "highlight" ? "panel.highlights" : "panel.notes")}
              </button>
            ))}
          </div>

          {/* HOW BIG THE SLIPS ARE. The same instrument the Library uses for cover size, on the same
              plate as the filters that already govern this wall — two marks for the ends of the
              range and the slider between them, rather than a labelled control competing with the
              chapter and the ink for the reader's attention. */}
          <div className="arch-size" title={t("arch.size")}>
            <span className="arch-size-mark sm" aria-hidden />
            <input
              type="range"
              className="libd-size"
              min={SCALE_MIN}
              max={SCALE_MAX}
              step={SCALE_STEP}
              value={scale}
              onChange={(e) => setScale(clampScale(Number(e.target.value)))}
              aria-label={t("arch.size")}
              // What a screen reader says instead of "1.35": how far along the range it is, which is
              // the only thing the number means to a reader.
              aria-valuetext={`${Math.round(((scale - SCALE_MIN) / (SCALE_MAX - SCALE_MIN)) * 100)}%`}
            />
            <span className="arch-size-mark lg" aria-hidden />
          </div>
          </div>
        </div>

        {wall.length === 0 ? (
          <div className="arch-empty">
            <div className="arch-empty-mark" aria-hidden><Icon name="quote" size="xl" /></div>
            <div className="arch-empty-title">{t("inbox.empty.none")}</div>
            <div className="arch-empty-sub">{t("inbox.empty.noneSub")}</div>
          </div>
        ) : (
          <SlipWall
            scale={scale}
            items={wall}
            hl={hl}
            dark={dark}
            paper={paper}
            accent={theme.colors.accent}
            noteLabel={t("ne.myNote")}
            chapter={(it) => it.chapter_label ?? ""}
            when={(it) => relTime(it.created_at, lang)}
            from={(it) => (it.sender ? t("arch.from", { name: it.sender }) : "")}
            readAll={t("arch.readSlip")}
            onOpen={setSheet}
          />
        )}

        {sheet && (
          <SlipSheet
            item={sheet}
            hl={hl}
            dark={dark}
            paper={paper}
            when={relTime(sheet.created_at, lang)}
            onClose={() => setSheet(null)}
            onRead={readInBook}
            onCard={composeCard}
            onChanged={() => setReloads((n) => n + 1)}
          />
        )}

        {card && (
          <PhotoComposer
            data={card}
            initialThemeId={useTheme.getState().bookThemeId ?? useTheme.getState().themeId}
            lang={lang}
            onClose={() => setCard(null)}
          />
        )}
      </div>
    );
  }

  // ── the cabinet ────────────────────────────────────────────────────────────────────────────────
  return (
    <div className="arch">
      <header className="arch-head">
        <div className="arch-head-top">
          <h1 className="arch-title">{t("lib.nav.highlights")}</h1>
          <span className="arch-count">
            {t("inbox.count", { n: num(items.length), m: num(drawers.length) })}
          </span>
        </div>

        <div className="arch-sub">
          <span className="arch-hint">{t("arch.hint")}</span>
          <span className="arch-rule" />
            {/* The search stands with the sort, on the line the controls are on — not across the
                header from the title, where it was the only control on a row of headings. */}
          <label className="arch-search in-line">
            <span className="arch-search-ico" aria-hidden><Icon name="search" size="sm" /></span>
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t("arch.searchAll")} />
          </label>
          <span className="arch-sort">{t("arch.sortOpened")}</span>
        </div>
      </header>

      {drawers.length === 0 ? (
        <div className="arch-empty">
          <div className="arch-empty-mark" aria-hidden><Icon name="quote" size="xl" /></div>
          <div className="arch-empty-title">{items.length === 0 ? t("inbox.empty.title") : t("inbox.empty.none")}</div>
          <div className="arch-empty-sub">{items.length === 0 ? t("inbox.empty.sub") : t("inbox.empty.noneSub")}</div>
        </div>
      ) : (
        <div className="arch-cabinet">
          <Cabinet
            drawers={drawers}
            hl={hl}
            dark={dark}
            face={chrome}
            text={{
              tally,
              opened: (at) => (at ? t("arch.opened", { when: relTime(at, lang) }) : t("arch.neverOpened")),
              pull: t("arch.pull"),
            }}
            onOpen={(d) => { setOpenBook(d.bookId); setSearch(""); }}
          />
        </div>
      )}
    </div>
  );
}
