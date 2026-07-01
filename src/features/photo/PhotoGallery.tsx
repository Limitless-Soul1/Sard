// Saved-cards gallery (RAWY-52, Photo Mode part 2a) — a cross-book "Cards" place in the Library
// sidebar (under Highlights & Notes) that lists every card the user chose to "Save in app", each
// a thumbnail of the actual stored PNG with its book · chapter · date. Open one to view it large
// and re-export (Save image / Copy image) or delete it. Empty state when there are none.

import { useEffect, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";

import { useI18n } from "../../i18n";
import { photocardDelete, photocardsList, type PhotoCardRow } from "../../lib/ipc";

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
        <div className="pg-overlay" onPointerDown={() => { setOpen(null); setConfirmDel(false); }}>
          <div className="pg-viewer" onPointerDown={(e) => e.stopPropagation()}>
            <button className="pg-close" onClick={() => setOpen(null)} aria-label={t("photo.close")}>✕</button>
            <div className="pg-viewer-img">
              <img src={convertFileSrc(open.image_path)} alt="" />
            </div>
            <div className="pg-viewer-side">
              <div className="pg-viewer-title" dir="auto">{open.book_title || t("cards.untitled")}</div>
              {open.chapter_label && <div className="pg-viewer-sub" dir="auto">{open.chapter_label}</div>}
              <div className="pg-viewer-date">{whenLabel(open.created_at, lang)}</div>
              <div className="pg-viewer-actions">
                <button className="pc-save" onClick={() => onSave(open)} disabled={busy}>{t("photo.save")}</button>
                <button className="pc-copy" onClick={() => onCopy(open)} disabled={busy}>{t("photo.copy")}</button>
              </div>
              {confirmDel ? (
                <div className="pg-confirm">
                  <span>{t("cards.deleteConfirm")}</span>
                  <div className="pg-confirm-row">
                    <button className="pg-del-yes" onClick={() => onDelete(open)}>{t("cards.delete")}</button>
                    <button className="pg-del-no" onClick={() => setConfirmDel(false)}>{t("cards.cancel")}</button>
                  </div>
                </div>
              ) : (
                <button className="pg-delete" onClick={() => setConfirmDel(true)}>{t("cards.delete")}</button>
              )}
            </div>
          </div>
        </div>
      )}

      {toast && <div className="pg-toast">{toast}</div>}
    </div>
  );
}
