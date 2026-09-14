// THE DEPOSIT SHEET — one sheet, a map and a sheaf.
//
// You do not pick from categories; you pick from the book. The sheet opens with the shape of the
// reading, and the marks hang beneath it as slips you unbind. Everything is bound when it opens: a
// deposit is a gift, so the sender releases what they would rather not send rather than hunting for
// what to include.
//
// WHAT LEAVES IS WHAT WAS READ. The manifest is built here, shown by «اقرأ الوديعة» exactly as it
// stands, and handed to `deposit_export`, which writes it verbatim.
import { useEffect, useMemo, useState } from "react";
import { useScrimDismiss } from "../../components/useDialog";
import { createPortal } from "react-dom";
import { useI18n } from "../../i18n";
import { localeNum } from "../../lib/format";
import { Icon } from "../../components/Icon";
import {
  depositExport,
  depositPlan,
  highlightsForBook,
  notesForBook,
  refsForBook,
  repsForBook,
  settingsGet,
  settingsSet,
  type BookRow,
  type DepositPlan,
  type HighlightRow,
  type NoteRow,
  type RefRow,
  type RepRow,
} from "../../lib/ipc";
import { coverSrc } from "../library/coverSrc";
import { DepositLayers, type LayerSlips } from "./DepositLayers";
import { DepositMap } from "./DepositMap";
import { DepositRead } from "./DepositRead";
import { bindAll, boundCount, setLayer, toggleMark } from "./model/bind";
import { buildMap, totalIn } from "./model/map";
import { useIncomingDeposit } from "./store";
import {
  buildManifest,
  emptySelection,
  isSendable,
  manifestText,
  markCount,
  type LayerKey,
  type Selection,
} from "./model/manifest";

/** The signature is remembered, because a reader signs with the same name every time. */
const SIGN_KEY = "deposit_signature";

const megabytes = (bytes: number, lang: string) =>
  `${localeNum(Math.max(1, Math.round(bytes / 1048576)), lang)} MB`;

export function DepositSheet({ book, onClose }: { book: BookRow; onClose: () => void }) {
  // The backdrop takes a press only when the gesture began there and ends clear of the sheet.
  const scrim = useScrimDismiss(onClose);

  const { t, lang } = useI18n();
  const [plan, setPlan] = useState<DepositPlan | null>(null);
  const [rows, setRows] = useState<{
    highlights: HighlightRow[];
    notes: NoteRow[];
    references: RefRow[];
    replacements: RepRow[];
  }>({ highlights: [], notes: [], references: [], replacements: [] });
  const [selection, setSelection] = useState<Selection>(emptySelection());
  const [openLayer, setOpenLayer] = useState<LayerKey | null>(null);
  const [letter, setLetter] = useState("");
  const [signed, setSigned] = useState("");
  const [includeBook, setIncludeBook] = useState(true);
  const [reading, setReading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [p, hl, no, re, rp, sign] = await Promise.all([
          depositPlan(book.id),
          highlightsForBook(book.id),
          notesForBook(book.id),
          refsForBook(book.id),
          repsForBook(book.id),
          settingsGet(SIGN_KEY).catch(() => null),
        ]);
        if (!alive) return;
        const data = { highlights: hl, notes: no, references: re, replacements: rp };
        setPlan(p);
        setRows(data);
        setSelection(bindAll(data)); // everything bound: you release, you do not hunt
        if (sign) setSigned(sign);
      } catch (e) {
        if (alive) setError(String(e));
      }
    })();
    return () => {
      alive = false;
    };
  }, [book.id]);

  const manifest = useMemo(() => {
    if (!plan) return null;
    return buildManifest({
      plan,
      highlights: rows.highlights,
      notes: rows.notes,
      references: rows.references,
      replacements: rows.replacements,
      selection,
      inscription: { text: letter, signed },
      includeBook,
      appVersion: "1.2.2",
      now: Math.floor(Date.now() / 1000),
    });
  }, [plan, rows, selection, letter, signed, includeBook]);

  const map = useMemo(
    () =>
      plan
        ? buildMap({
            plan,
            bound: selection,
          })
        : null,
    [plan, selection],
  );

  // «في الوديعة» — the manifest line, read off the manifest itself rather than off the checkboxes.
  const parts = useMemo(() => {
    if (!manifest) return [];
    const out: string[] = [];
    const m = manifest.marks;
    if (m.highlights.length) out.push(t("dep.part.highlights", { n: localeNum(m.highlights.length, lang) }));
    if (m.notes.length) out.push(t("dep.part.notes", { n: localeNum(m.notes.length, lang) }));
    if (m.references.length) out.push(t("dep.part.references", { n: localeNum(m.references.length, lang) }));
    if (m.replacements.length) out.push(t("dep.part.replacements", { n: localeNum(m.replacements.length, lang) }));
    if (manifest.inscription.text.trim()) out.push(t("dep.part.letter"));
    if (manifest.book.file) out.push(t("dep.part.book"));
    return out;
  }, [manifest, t, lang]);

  // WHILE THIS SHEET IS OPEN, AN ARRIVING DEPOSIT WAITS. Announced for exactly as long as the sheet
  // is mounted, so every way out of it — the corner mark, the scrim, cancel, or a finished deposit —
  // releases the wait without any of them having to know that it exists.
  const setComposing = useIncomingDeposit((s) => s.setComposing);
  useEffect(() => {
    setComposing(true);
    return () => setComposing(false);
  }, [setComposing]);

  const give = async () => {
    if (!plan || !manifest) return;
    setError(null);
    const { save } = await import("@tauri-apps/plugin-dialog");
    const base = (book.title || "deposit").replace(/[\\/:*?"<>|]/g, "").slice(0, 60).trim() || "deposit";
    // AN ORDINARY ZIP, AND NOT ONLY IN NAME. The container has always been one — `deposit.json`, a
    // `book/` folder and a `cover/` folder, Deflated — so nothing about the file itself changes here
    // except what the world calls it. Whoever receives it can open it with the tools he already has,
    // and a deposit reads as something shareable before Sard is involved at all.
    const picked = await save({
      defaultPath: `${base}.zip`,
      filters: [{ name: "ZIP", extensions: ["zip"] }],
    });
    if (typeof picked !== "string") return;
    setBusy(true);
    try {
      const text = manifestText(manifest);
      await depositExport(
        picked,
        text,
        manifest.book.file && plan.book_source && plan.book_member
          ? { member: plan.book_member, source: plan.book_source }
          : null,
        manifest.book.cover && plan.cover_source && plan.cover_member
          ? { member: plan.cover_member, source: plan.cover_source }
          : null,
      );
      if (signed.trim()) void settingsSet(SIGN_KEY, signed.trim()).catch(() => {});
      setDone(picked);
    } catch (e) {
      const code = String(e);
      setError(code.startsWith("dep.err.") ? t(code.split(":")[0] as never) : code);
    } finally {
      setBusy(false);
    }
  };

  // The sender's slips are read off their own rows; the receiver's off the manifest. One sheaf, two
  // sources, so the component never has to know which side it is serving.
  const slips: LayerSlips = useMemo(
    () => ({
      highlights: rows.highlights.map((h) => ({ id: h.id, text: h.text_excerpt ?? "", place: h.chapter_label })),
      notes: rows.notes.map((n) => ({
        id: n.id,
        text: n.title || n.body || "",
        under: n.title ? n.body : null,
        place: n.chapter_label,
      })),
      references: rows.references.map((r) => ({ id: r.id, text: r.phrase, under: r.note, place: t("dep.wholeBook") })),
      replacements: rows.replacements.map((r) => ({
        id: r.id,
        text: r.phrase,
        under: r.replacement,
        place: t("dep.wholeBook"),
      })),
    }),
    [rows, t],
  );

  const cover = coverSrc(book);
  const size = plan ? plan.book_bytes + plan.cover_bytes : 0;
  const bookLine = includeBook
    ? t("dep.bookWith", { size: megabytes(size, lang) })
    : t("dep.bookWithout", { size: megabytes(Math.max(plan?.cover_bytes ?? 0, 1024), lang) });

  const body = done ? (
    <div className="dep-done">
      <Icon name="deposit" size="md" />
      <h2>{t("dep.doneTitle")}</h2>
      <p className="dep-note">{t("dep.doneBody")}</p>
      <div className="dep-path" dir="ltr">
        {done}
      </div>
      <div className="dep-actions">
        <button
          type="button"
          className="dep-btn dep-btn-primary"
          onClick={async () => {
            const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
            revealItemInDir(done).catch(() => {});
          }}
        >
          {t("dep.donePrimary")}
        </button>
        <button type="button" className="dep-btn" onClick={onClose}>
          {t("dep.doneBack")}
        </button>
      </div>
    </div>
  ) : (
    <>
      <header className="dep-head">
        {/* THE BOOK IS PRESENT, not merely named: its cover stands beside the title, and the chapter
            count says how much book the map below is drawn across. */}
        {/* THE COVER LEADS. In DOM order it comes first, so it sits beside the title on the reading
            side — right in Arabic, left in English — and the corner mark keeps the other corner to
            itself instead of landing on the artwork. */}
        <div className="dep-head-row">
          {cover && <img className="dep-cover" src={cover} alt="" />}
          <div className="dep-head-text">
            <span className="dep-eyebrow">{t("dep.eyebrow")}</span>
            <h2 className="dep-title">{book.title}</h2>
            {book.author && <span className="dep-note">{book.author}</span>}
            {plan?.spine_count ? (
              <span className="dep-chapters">
                {t("dep.chapters", { n: localeNum(plan.spine_count, lang) })}
              </span>
            ) : null}
          </div>
        </div>
        <label className="dep-bookline">
          <input type="checkbox" checked={includeBook} onChange={(e) => setIncludeBook(e.target.checked)} />
          <span>{bookLine}</span>
        </label>
      </header>

      <section className="dep-letter">
        <span className="dep-label">{t("dep.letterLabel")}</span>
        <textarea
          className="dep-letter-field"
          value={letter}
          onChange={(e) => setLetter(e.target.value)}
          placeholder={t("dep.letterPlaceholder")}
          rows={Math.max(3, Math.min(12, Math.ceil(letter.length / 52) + 2))}
        />
        <div className="dep-sign">
          <input
            className="dep-sign-field"
            value={signed}
            onChange={(e) => setSigned(e.target.value)}
            placeholder={t("dep.signPlaceholder")}
          />
          <span className="dep-note">{t("dep.signNote")}</span>
        </div>
      </section>

      {/* The map is a control as well as a picture: pressing a stratum takes or releases that whole
          layer, through the SAME setter the layer's own checkbox uses below. */}
      {map && (
        <DepositMap
          map={map}
          marks={manifest ? markCount(manifest) : 0}
          onSetLayer={(k, on) => setSelection((s) => setLayer(s, k, rows, on))}
        />
      )}

      <div className="dep-sheaf-bar">
        <button type="button" className="dep-chip" onClick={() => setReading(true)} disabled={!manifest}>
          <Icon name="bookOpen" size="sm" />
          {t("dep.readLabel")}
        </button>
      </div>

      <DepositLayers
        slips={slips}
        selection={selection}
        openLayer={openLayer}
        onOpen={setOpenLayer}
        onSetLayer={(k, on) => setSelection((s) => setLayer(s, k, rows, on))}
        onToggleMark={(k, id) => setSelection((s) => toggleMark(s, k, id))}
        unplaced={map ? totalIn(map.sectionless) : 0}
      />

      <footer className="dep-foot">
        <div className="dep-summary">
          <span className="dep-label">{t("dep.sumLabel")}</span>
          {parts.length ? (
            <span className="dep-parts">
              {parts.map((p, i) => (
                <span key={i}>{p}</span>
              ))}
            </span>
          ) : (
            <span className="dep-note">{t("dep.manifestNone")}</span>
          )}
        </div>
        {error && <p className="dep-error">{error}</p>}
        <div className="dep-actions">
          <button
            type="button"
            className="dep-btn dep-btn-primary dep-btn-wide"
            onClick={() => void give()}
            disabled={busy || !manifest || !isSendable(manifest)}
          >
            {t("dep.cta")}
          </button>
          <button type="button" className="dep-btn dep-btn-quiet" onClick={onClose}>
            {t("dep.cancel")}
          </button>
        </div>
      </footer>
    </>
  );

  return createPortal(
    <div className="dep-scrim" {...scrim.scrimProps}>
      <div
        className="dep-sheet"
        ref={scrim.panelRef}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={t("dep.eyebrow")}
      >
        {!done && (
          <button
            type="button"
            className="dep-x"
            onClick={onClose}
            title={t("dep.closeSheet")}
            aria-label={t("dep.closeSheet")}
          >
            <Icon name="close" size="sm" />
          </button>
        )}
        {body}
        {reading && manifest && (
          <div className="dep-read-scrim" onClick={() => setReading(false)}>
            <div onClick={(e) => e.stopPropagation()}>
              <DepositRead manifest={manifest} onClose={() => setReading(false)} />
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

/** How many marks the sender has bound — used by the caller for its own summary line. */
export const boundInSelection = boundCount;
