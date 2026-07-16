// Cross-book Highlights & Notes inbox (RAWY-27, design band D). A calm, searchable list of
// EVERY highlight + standalone note across all books — each with its colour, the book and
// chapter, and (for a highlight that has a note) the note body. Filter by colour / book /
// type, search the text, and click an item to open that book at its CFI. UI chrome → theme
// tokens, mirrors with the UI language; Arabic items render in Amiri / RTL by their book dir.

import { useEffect, useMemo, useState, type CSSProperties } from "react";

import { useI18n } from "../../i18n";
import { localeDigits } from "../../lib/format";
import { THEMES, useTheme } from "../../theme";
import { colorValue, HIGHLIGHT_SLOTS, isHex } from "../reader/highlightColors";
import { annotationsAll, tagsList, type AnnoItem } from "../../lib/ipc";
import type { OpenTarget } from "./Library";

const ARABIC = /[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]/;
type TypeFilter = "all" | "highlight" | "note";

function relTime(sec: number | null, lang: string): string {
  if (!sec) return "";
  const days = Math.round((Date.now() / 1000 - sec) / 86400);
  const rtf = new Intl.RelativeTimeFormat(lang === "ar" ? "ar" : "en", { numeric: "auto" });
  if (Math.abs(days) < 1) return rtf.format(0, "day");
  if (Math.abs(days) < 30) return rtf.format(-days, "day");
  return new Intl.DateTimeFormat(lang === "ar" ? "ar" : "en", { month: "short", day: "numeric", year: "numeric" }).format(
    new Date(sec * 1000),
  );
}

export function Inbox({ onOpen }: { onOpen: (b: OpenTarget) => void }) {
  const { t, lang } = useI18n();
  const hl = THEMES[useTheme((s) => s.themeId)].colors.highlight;
  const [items, setItems] = useState<AnnoItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [search, setSearch] = useState("");
  const [color, setColor] = useState<string | null>(null); // a slot, "custom", or null
  const [book, setBook] = useState<string | null>(null);
  const [type, setType] = useState<TypeFilter>("all");
  const [bookMenu, setBookMenu] = useState(false);
  const [tag, setTag] = useState<string | null>(null); // RAWY-203: filter by a tag name
  const [tagMenu, setTagMenu] = useState(false);
  const [tagNames, setTagNames] = useState<string[]>([]); // RAWY-204: ALL tags (the tags table)

  useEffect(() => {
    annotationsAll()
      .then((rows) => setItems(rows))
      .catch(console.error)
      .finally(() => setLoaded(true));
    // RAWY-204: the tag-filter options come from the tags TABLE (every tag the user made), not from the
    // tags on loaded notes — otherwise a tag with zero current note links (e.g. one just re-created after a
    // delete) is invisible in the filter though it exists. Selecting such a tag simply yields an empty list.
    tagsList().then((ts) => setTagNames(ts.map((x) => x.name))).catch(console.error);
  }, []);

  // Distinct books present (for the "All books" filter).
  const books = useMemo(() => {
    const m = new Map<string, string>();
    for (const it of items) if (!m.has(it.book_id)) m.set(it.book_id, it.book_title || "—");
    return [...m].map(([id, title]) => ({ id, title }));
  }, [items]);

  // RAWY-204: the tag-filter options = every tag in the tags table (union'd with any tag seen on a loaded
  // item, so nothing is ever missed even before `tagsList` resolves). Previously this was ONLY the tags on
  // loaded notes, which hid a valid tag that had no current links (a re-created tag) — the reported bug.
  const allTags = useMemo(() => {
    const s = new Set<string>(tagNames);
    for (const it of items) for (const tg of it.tags) s.add(tg);
    return [...s].sort((a, b) => a.localeCompare(b, lang, { sensitivity: "base" }));
  }, [items, tagNames, lang]);

  const matchColor = (c: string | null) =>
    !color || (color === "custom" ? isHex(c) : c === color);
  const q = search.trim().toLowerCase();
  const filtered = items.filter((it) => {
    if (type !== "all" && it.kind !== type) return false;
    if (book && it.book_id !== book) return false;
    if (tag && !it.tags.includes(tag)) return false; // RAWY-203: an item shows under each of its tags
    if (!matchColor(it.color)) return false;
    if (q) {
      const hay = `${it.text ?? ""} ${it.note ?? ""} ${it.book_title ?? ""} ${it.chapter_label ?? ""} ${it.tags.join(" ")}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  const open = (it: AnnoItem) =>
    onOpen({ id: it.book_id, filePath: it.file_path, dir: it.book_dir, cfi: it.cfi });

  if (!loaded) return null;

  return (
    <div className="inbox">
      <header className="inbox-head">
        <div className="inbox-head-top">
          <div className="inbox-title-wrap">
            <h1 className="inbox-title">{t("lib.nav.highlights")}</h1>
            <span className="inbox-count">
              {t("inbox.count", { n: localeDigits(String(items.length), lang), m: localeDigits(String(books.length), lang) })}
            </span>
          </div>
          <label className="lib-search inbox-search">
            <span className="lib-search-ico" aria-hidden>⌕</span>
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t("inbox.search")} />
          </label>
        </div>

        <div className="inbox-filters">
          <div className="inbox-dots">
            <button
              className={`inbox-dot inbox-dot-all${color === null ? " on" : ""}`}
              onClick={() => setColor(null)}
              title={t("inbox.all")}
            >
              ◍
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

          <span className="inbox-sep" />

          <div className="inbox-ctl-wrap">
            <button className="inbox-ctl" onClick={() => setBookMenu((o) => !o)}>
              {book ? books.find((b) => b.id === book)?.title ?? t("inbox.allBooks") : t("inbox.allBooks")} ▾
            </button>
            {bookMenu && (
              <>
                <div className="lib-clickaway" onClick={() => setBookMenu(false)} />
                <div className="lib-menu inbox-menu">
                  <button className={book === null ? "active" : ""} onClick={() => { setBook(null); setBookMenu(false); }}>
                    {t("inbox.allBooks")}
                  </button>
                  {books.map((b) => (
                    <button
                      key={b.id}
                      className={book === b.id ? "active" : ""}
                      dir={ARABIC.test(b.title) ? "rtl" : "ltr"}
                      onClick={() => { setBook(b.id); setBookMenu(false); }}
                    >
                      {b.title}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>

          {/* RAWY-203: filter by tag — same dropdown pattern as the book filter. Only shown once tags exist. */}
          {allTags.length > 0 && (
            <div className="inbox-ctl-wrap">
              <button className="inbox-ctl" onClick={() => setTagMenu((o) => !o)}>
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
                        dir={ARABIC.test(tg) ? "rtl" : "ltr"}
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
        </div>
      </header>

      {filtered.length === 0 ? (
        <div className="inbox-empty">
          <div className="inbox-empty-mark" aria-hidden>❝</div>
          <div className="inbox-empty-title">{items.length === 0 ? t("inbox.empty.title") : t("inbox.empty.none")}</div>
          <div className="inbox-empty-sub">{items.length === 0 ? t("inbox.empty.sub") : t("inbox.empty.noneSub")}</div>
        </div>
      ) : (
        <div className="inbox-list">
          {filtered.map((it) => {
            const swatch = colorValue(it.color, hl);
            const arabic = it.book_dir === "rtl" || ARABIC.test(it.text ?? "");
            return (
              <button
                key={`${it.kind}-${it.id}`}
                className="inbox-card"
                style={{ "--swatch": swatch } as CSSProperties}
                onClick={() => open(it)}
                dir={arabic ? "rtl" : "ltr"}
              >
                <span className="inbox-card-bar" />
                <span className="inbox-card-body">
                  <span className={`inbox-card-text${arabic ? " ar" : ""}`}>{it.text}</span>
                  <span className="inbox-card-meta">
                    {it.kind === "note" && <span className="inbox-card-kind">{t("panel.marginNote")} · </span>}
                    {[it.book_title, it.chapter_label, relTime(it.created_at, lang)].filter(Boolean).join(" · ")}
                  </span>
                  {it.note && (
                    <span className="inbox-card-note">
                      <span className="inbox-card-note-label">{t("hl.note")} · </span>
                      {it.note}
                    </span>
                  )}
                  {it.tags.length > 0 && (
                    <span className="inbox-card-tags">
                      {it.tags.map((tg) => <span key={tg} className="inbox-tag">{tg}</span>)}
                    </span>
                  )}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
