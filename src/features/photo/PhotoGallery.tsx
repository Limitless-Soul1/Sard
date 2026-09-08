// Saved-cards gallery (RAWY-52, Photo Mode part 2a) — a cross-book "Cards" place in the Library
// sidebar (under Highlights & Notes) that lists every card the user chose to "Save in app", each
// a thumbnail of the actual stored PNG with its book · chapter · date. Open one to view it large
// and re-export (Save image / Copy image) or delete it. Empty state when there are none.

import { useEffect, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";

import { useI18n } from "../../i18n";
import { SelectionBar, SelectionTick, useListSelection } from "../../components/listSelection";
import { useScrimDismiss } from "../../components/useDialog";
import { localeNum, uiDateTimeFormat } from "../../lib/format";
import { isBuiltinThemeId, resolveTheme, useTheme, type ThemeId } from "../../theme";
import { photocardDelete, photocardsList, savePhotoCardFile, type PhotoCardRow } from "../../lib/ipc";
import { PhotoComposer } from "./PhotoComposer";
import { FORMATS, type CardData, type CardFormat, type CardPassage } from "./photo";
import { isArabicText } from "../../lib/typography";
import { compositionFromLegacy, newCustomComposition, parseComposition } from "./composition";


// Reopen a saved card in the composer (RAWY-57 Edit): rebuild CardData from the stored row.
// Format + theme are restored; the direction is inferred from the text; the show-on-card toggles
// were not stored, so they fall back to the defaults (noted). A multi-passage card (RAWY-60)
// restores its full collection from the stored `passages` JSON so Edit re-composes it faithfully.
function rowToCardData(row: PhotoCardRow): CardData {
  let passages: CardPassage[] | undefined;
  if (row.passages) {
    try {
      const parsed = JSON.parse(row.passages);
      if (Array.isArray(parsed) && parsed.length) passages = parsed as CardPassage[];
    } catch {
      /* malformed → fall back to the single quote */
    }
  }
  const dirText = passages ? passages.map((p) => p.text).join(" ") : row.quote ?? "";
  return {
    quote: row.quote ?? "",
    passages,
    dir: isArabicText(dirText) ? "rtl" : "ltr",
    bookId: row.book_id ?? undefined,
    cfi: row.cfi ?? undefined,
    bookTitle: row.book_title ?? undefined,
    author: row.author ?? undefined,
    chapterLabel: row.chapter_label ?? undefined,
    date: new Date(row.created_at * 1000),
  };
}
// `isBuiltinThemeId` is exactly what `id in THEMES` meant, without the cast. A saved card keeps
// naming one of the SHIPPED sixteen: a card is an exported artefact, so resolving it against a
// theme the reader may since have edited or deleted would change an image already made.
const validTheme = (id: string | null): ThemeId | null => (isBuiltinThemeId(id) ? id : null);

// The lightbox backdrop + pill follow the SAVED CARD's polarity (RAWY-58), not the Library theme:
// a light-theme card → the warm backdrop; a dark-theme card → the near-black one. An unknown
// theme falls back to light.
const cardIsDark = (themeId: string | null): boolean => {
  const t = validTheme(themeId);
  return t ? resolveTheme(t).dark : false;
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
    return uiDateTimeFormat(lang, {
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
  const [creating, setCreating] = useState(false); // a card with no book behind it
  const sel = useListSelection(cards.map((c) => c.id));
  // The lightbox leaves by a press beside the card — but not by a press that GRAZED it, and not by
  // one that began on the card and ended past its edge. See `useScrimDismiss`.
  const lightbox = useScrimDismiss(() => { setOpen(null); setConfirmDel(false); });

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
        await savePhotoCardFile(path, await blob.arrayBuffer());
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

  // THE SAME DELETION, over the chosen cards. It goes through `photocardDelete` exactly as one card
  // does — the row is removed here only for the ids the backend actually accepted, so a failure
  // leaves the card on screen rather than vanishing it from a list it is still in.
  const onDeleteChosen = async () => {
    const ids = [...sel.selected];
    const gone: string[] = [];
    for (const id of ids) {
      try {
        await photocardDelete(id);
        gone.push(id);
      } catch (e) {
        console.error(e);
      }
    }
    if (gone.length) {
      const dead = new Set(gone);
      setCards((cs) => cs.filter((c) => !dead.has(c.id)));
    }
    sel.exit();
  };

  if (!loaded) return <div className="lib-main pg-root" />;

  return (
    <div className="lib-main pg-root">
      <header className="pg-head">
        {/* Title and count on one ground — see `ui-page-title`. */}
        <span className="ui-page-title">
          <h1 className="pg-title">{t("cards.title")}</h1>
          <span className="pg-count">{cards.length > 0 ? t("cards.count", { n: localeNum(cards.length, lang) }) : ""}</span>
        </span>
        {/* A card does not have to come from a passage. This is a first-class way in, not a detour
            through a book: nothing about the composer needs a book, and a card made here claims no
            provenance it does not have.

            IT STANDS DOWN WHILE THE READER IS CHOOSING. The head is the page's one row of actions,
            and during a selection every action in it should be about the cards that are chosen —
            "make another" is a different task, and leaving it there is what crowded the row and made
            the selection controls look like a second, competing set. */}
        {!sel.on && (
        <button className="pg-new" onClick={() => setCreating(true)}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <rect x="4" y="3" width="16" height="18" rx="2" /><path d="M12 8v8M8 12h8" />
          </svg>
          <span>{t("photo.newCard")}</span>
        </button>
        )}
        {/* THE SELECTION CONTROLS BELONG TO THIS ROW, not to a row of their own.
            They had one: a second strip under the head, hugging the far edge, which is what put one
            control above and another below and made the page read as improvised. There is one row of
            page actions on this shelf, and choosing cards is one of them — so «تحديد» stands beside
            «أنشئ بطاقة مصوّرة», and pressing it turns that same place into the toolbar. */}
        {cards.length > 0 && (
          <SelectionBar
            sel={sel}
            total={cards.length}
            actions={[{
              key: "delete",
              icon: "trash" as const,
              label: t("cards.delete"),
              confirm: t("cards.deleteConfirm"),
              danger: true,
              run: () => void onDeleteChosen(),
            }]}
          />
        )}
      </header>

      {/* THE GALLERY'S OWN ROW OF LIST CONTROLS.

          It used to be a bare bar floating under the heading at the far edge, and it changed size
          and height when the mode came on — so the grid moved under it and the controls landed
          somewhere new on the press that turned selection on. A row that is ALWAYS drawn, at a
          fixed height and on the grid's own column, is what makes it a toolbar instead: the same
          relationship the archive's filter plate has to the wall it narrows. */}
      {cards.length === 0 ? (
        <div className="pg-empty">
          <img className="pg-empty-bird" src="/assets/sard-bird.png" alt="" />
          <div className="pg-empty-title">{t("cards.empty.title")}</div>
          <div className="pg-empty-hint">{t("cards.empty.hint")}</div>
        </div>
      ) : (
        <div className="pg-grid">
          {cards.map((c) => (
            <button
              key={c.id}
              className={`pg-cell${sel.has(c.id) ? " sel-on" : ""}`}
              aria-pressed={sel.on ? sel.has(c.id) : undefined}
              onClick={() => {
                // While the mode is on, a press CHOOSES rather than opens. The cell is already a
                // button, so the tick is drawn as a mark on it rather than as a second button
                // inside one — which is not valid markup and is not operable by keyboard either.
                if (sel.on) { sel.toggle(c.id); return; }
                setOpen(c);
                setConfirmDel(false);
              }}
            >
              <span className="pg-thumb">
                <img src={convertFileSrc(c.image_path)} alt="" loading="lazy" />
                {sel.on && <span className="pg-pick"><SelectionTick state={sel.has(c.id)} /></span>}
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
          {...lightbox.scrimProps}
        >
          <button className="pg-lb-close ui-close" onClick={() => setOpen(null)} aria-label={t("photo.close")}>✕</button>
          <div className="pg-lb-stage" ref={lightbox.panelRef} onPointerDown={(e) => e.stopPropagation()}>
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
          // THE FIX FOR THE ROUND TRIP. A card's style, size and toggles used to be dropped here:
          // this call passed the default toggles and no style at all, so a Gilded XL card reopened
          // as Minimal auto-fit and Save then overwrote the good PNG. The document carries them
          // now; a card saved before it existed gets a deterministic reconstruction from its own
          // columns, which is exactly what this call used to do — so nothing about an old card moves.
          initialComposition={parseComposition(editing.doc) ?? compositionFromLegacy(editing)}
          initialQuoteFont={editing.quote_font}
          editId={editing.id}
          lang={lang}
          onClose={() => { setEditing(null); load(); }}
        />
      )}

      {creating && (
        <PhotoComposer
          // No book id, no title, no chapter, no author — and the composition's metadata toggles are
          // all off. A custom card must not invent a provenance, so there is nothing to invent from.
          data={{ quote: "", dir: lang === "ar" ? "rtl" : "ltr", date: new Date() }}
          initialThemeId={useTheme.getState().bookThemeId ?? useTheme.getState().themeId}
          initialComposition={newCustomComposition(
            useTheme.getState().bookThemeId ?? useTheme.getState().themeId,
            "portrait",
            t("photo.customQuote"),
          )}
          lang={lang}
          onClose={() => { setCreating(false); load(); }}
        />
      )}

      {toast && <div className="pg-toast">{toast}</div>}
    </div>
  );
}
