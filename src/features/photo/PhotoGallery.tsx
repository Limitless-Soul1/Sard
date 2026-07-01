// Saved-cards gallery (RAWY-52, Photo Mode part 2a) — a cross-book "Cards" place in the Library
// sidebar (under Highlights & Notes) that lists every card the user chose to "Save in app", each
// a thumbnail of the actual stored PNG with its book · chapter · date. Open one to view it large
// and re-export (Save image / Copy image) or delete it. Empty state when there are none.

import { useEffect, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";

import { useI18n } from "../../i18n";
import { THEMES, useTheme, type ThemeId } from "../../theme";
import { photocardDelete, photocardsList, type PhotoCardRow } from "../../lib/ipc";
import { PhotoComposer } from "./PhotoComposer";
import { DEFAULT_META, FORMATS, type CardData, type CardFormat } from "./photo";

const ARABIC = /[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]/;

// Reopen a saved card in the composer (RAWY-57 Edit): rebuild CardData from the stored row.
// Format + theme are restored; the direction is inferred from the quote; the show-on-card
// toggles were not stored, so they fall back to the defaults (noted).
function rowToCardData(row: PhotoCardRow): CardData {
  return {
    quote: row.quote ?? "",
    dir: ARABIC.test(row.quote ?? "") ? "rtl" : "ltr",
    bookId: row.book_id ?? undefined,
    cfi: row.cfi ?? undefined,
    bookTitle: row.book_title ?? undefined,
    author: row.author ?? undefined,
    chapterLabel: row.chapter_label ?? undefined,
    date: new Date(row.created_at * 1000),
  };
}
const validTheme = (id: string | null): ThemeId | null => (id && id in THEMES ? (id as ThemeId) : null);

// The lightbox backdrop + pill follow the SAVED CARD's polarity (RAWY-58), not the Library theme:
// a light-theme card → the warm backdrop; a dark-theme card → the near-black one. An unknown
// theme falls back to light.
const cardIsDark = (themeId: string | null): boolean => {
  const t = validTheme(themeId);
  return t ? THEMES[t].dark : false;
};
const validFormat = (f: string | null): CardFormat | undefined => FORMATS.find((x) => x.key === f)?.key;

// Line icons for the lightbox action pill (stroke = currentColor so they inherit the button ink).
const IconDownload = () => (
  <svg className="pg-lb-ico" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" />
  </svg>
);
const IconCopy = () => (
  <svg className="pg-lb-ico" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </svg>
);
const IconTrash = () => (
  <svg className="pg-lb-ico" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    <line x1="10" y1="11" x2="10" y2="17" /><line x1="14" y1="11" x2="14" y2="17" />
  </svg>
);
const IconEdit = () => (
  <svg className="pg-lb-ico" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" /><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4z" />
  </svg>
);

function whenLabel(sec: number, lang: string): string {
  try {
    return new Intl.DateTimeFormat(lang === "ar" ? "ar" : "en", {
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(sec * 1000));
  } catch {
    return "";
  }
}

// Read the stored PNG back as a Blob (via the asset protocol) so we can re-export it.
async function cardBlob(imagePath: string): Promise<Blob> {
  const res = await fetch(convertFileSrc(imagePath));
  return res.blob();
}

export function PhotoGallery() {
  const { t, lang } = useI18n();
  const [cards, setCards] = useState<PhotoCardRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [open, setOpen] = useState<PhotoCardRow | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [confirmDel, setConfirmDel] = useState(false);
  const [editing, setEditing] = useState<PhotoCardRow | null>(null); // RAWY-57: Edit → composer

  const load = () => {
    photocardsList()
      .then(setCards)
      .catch(console.error)
      .finally(() => setLoaded(true));
  };
  useEffect(load, []);

  const flash = (m: string) => {
    setToast(m);
    window.setTimeout(() => setToast(null), 1900);
  };

  const onSave = async (card: PhotoCardRow) => {
    if (busy) return;
    setBusy(true);
    try {
      const blob = await cardBlob(card.image_path);
      const stamp = new Date(card.created_at * 1000).toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const path = await save({ defaultPath: `sard-quote-${stamp}.png`, filters: [{ name: "PNG image", extensions: ["png"] }] });
      if (path) {
        const bytes = Array.from(new Uint8Array(await blob.arrayBuffer()));
        await invoke("save_photo_card", { path, data: bytes });
        flash(t("photo.saved"));
      }
    } catch (e) {
      console.error(e);
      flash(t("photo.saveFail"));
    } finally {
      setBusy(false);
    }
  };

  const onCopy = async (card: PhotoCardRow) => {
    if (busy) return;
    setBusy(true);
    try {
      const blob = await cardBlob(card.image_path);
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      flash(t("photo.copied"));
    } catch (e) {
      console.error(e);
      flash(t("photo.copyFail"));
    } finally {
      setBusy(false);
    }
  };

  const onDelete = async (card: PhotoCardRow) => {
    try {
      await photocardDelete(card.id);
      setCards((cs) => cs.filter((c) => c.id !== card.id));
      setOpen(null);
      setConfirmDel(false);
    } catch (e) {
      console.error(e);
    }
  };

  if (!loaded) return <div className="lib-main pg-root" />;

  return (
    <div className="lib-main pg-root">
      <header className="pg-head">
        <h1 className="pg-title">{t("cards.title")}</h1>
        <span className="pg-count">{cards.length > 0 ? t("cards.count", { n: cards.length }) : ""}</span>
      </header>

      {cards.length === 0 ? (
        <div className="pg-empty">
          <img className="pg-empty-bird" src="/assets/sard-bird.png" alt="" />
          <div className="pg-empty-title">{t("cards.empty.title")}</div>
          <div className="pg-empty-hint">{t("cards.empty.hint")}</div>
        </div>
      ) : (
        <div className="pg-grid">
          {cards.map((c) => (
            <button key={c.id} className="pg-cell" onClick={() => { setOpen(c); setConfirmDel(false); }}>
              <span className="pg-thumb">
                <img src={convertFileSrc(c.image_path)} alt="" loading="lazy" />
              </span>
              <span className="pg-meta-title" dir="auto">{c.book_title || t("cards.untitled")}</span>
              {c.chapter_label && <span className="pg-meta-sub" dir="auto">{c.chapter_label}</span>}
              <span className="pg-meta-date">{whenLabel(c.created_at, lang)}</span>
            </button>
          ))}
        </div>
      )}

      {open && (
        <div
          className={`pg-lightbox${cardIsDark(open.theme_id) ? " dark" : ""}`}
          onPointerDown={() => { setOpen(null); setConfirmDel(false); }}
        >
          <button className="pg-lb-close" onClick={() => setOpen(null)} aria-label={t("photo.close")}>✕</button>
          <div className="pg-lb-stage" onPointerDown={(e) => e.stopPropagation()}>
            {/* the saved card, large — the hero */}
            <div className="pg-lb-card">
              <img src={convertFileSrc(open.image_path)} alt="" />
            </div>
            {/* a quiet caption: book · chapter · date */}
            <div className="pg-lb-caption" dir="auto">
              {[open.book_title, open.chapter_label, whenLabel(open.created_at, lang)].filter(Boolean).join("  ·  ")}
            </div>
            {/* one floating action pill */}
            <div className="pg-lb-pill">
              {confirmDel ? (
                <>
                  <span className="pg-lb-confirm-text">{t("cards.deleteConfirm")}</span>
                  <button className="pg-lb-del confirm" onClick={() => onDelete(open)}><IconTrash />{t("cards.delete")}</button>
                  <button className="pg-lb-cancel" onClick={() => setConfirmDel(false)}>{t("cards.cancel")}</button>
                </>
              ) : (
                <>
                  <button className="pg-lb-save" onClick={() => onSave(open)} disabled={busy}><IconDownload />{t("photo.save")}</button>
                  <button className="pg-lb-copy" onClick={() => onCopy(open)} disabled={busy}><IconCopy />{t("photo.copy")}</button>
                  <button className="pg-lb-edit" onClick={() => { setEditing(open); setOpen(null); }}><IconEdit />{t("cards.edit")}</button>
                  <span className="pg-lb-sep" />
                  <button className="pg-lb-del" onClick={() => setConfirmDel(true)}><IconTrash />{t("cards.delete")}</button>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Edit (RAWY-57): reopen the composer pre-loaded with the saved card; re-save overwrites it. */}
      {editing && (
        <PhotoComposer
          data={rowToCardData(editing)}
          initialThemeId={validTheme(editing.theme_id) ?? useTheme.getState().bookThemeId}
          initialFormat={validFormat(editing.format)}
          initialMeta={DEFAULT_META}
          editId={editing.id}
          lang={lang}
          onClose={() => { setEditing(null); load(); }}
        />
      )}

      {toast && <div className="pg-toast">{toast}</div>}
    </div>
  );
}
