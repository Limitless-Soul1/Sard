// THE SAME OBJECT, MIRRORED.
//
// A deposit arrives and is met on the sheet it was made on: the sender's inscription, HIS map, and the
// sheaf — except that here you unbind what you would rather not take. Every label flips voice:
// «خريطة قراءتي» becomes «خريطة قراءته», «في الوديعة» becomes «سيصير لك», «ما ظلّلتُه» becomes «ما ظلّله».
//
// READING TAKES NOTHING. `deposit_inspect` reads the manifest and changes nothing; the sheet renders
// from that alone. The database is not touched until «أضِف ما أبقيتَه إلى قراءتي», and then in one
// transaction that can only add.
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../../i18n";
import { localeNum } from "../../lib/format";
import { Icon } from "../../components/Icon";
import {
  depositCommit,
  depositInspect,
  depositMember,
  libraryListBooks,
  refsForBook,
  repsForBook,
  type BookRow,
  type DepositOutcome,
  type DepositPlan,
  type RefRow,
  type RepRow,
} from "../../lib/ipc";
import { DepositLayers, type LayerSlips } from "./DepositLayers";
import { DepositMap } from "./DepositMap";
import { DepositRead } from "./DepositRead";
import { buildMap } from "./model/map";
import { inspectDeposit, type Inspection } from "./model/inspect";
import { emptySelection, LAYERS, type DepositManifest, type LayerKey, type Selection } from "./model/manifest";
import { useIncomingDeposit } from "./store";
import { useBookDetailsRequest } from "../library/bookDetailsRequest";

/** What the receiver is being asked about their own copy of the book. */
type BookState = "same" | "brings" | "absent";

export function DepositReceive({ path, onClose }: { path: string; onClose: () => void }) {
  const { t, lang } = useI18n();
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const [book, setBook] = useState<BookRow | null>(null);
  const [mine, setMine] = useState<{ refs: RefRow[]; reps: RepRow[] }>({ refs: [], reps: [] });
  const [selection, setSelection] = useState<Selection>(emptySelection());
  const [takeTheirs, setTakeTheirs] = useState<Set<string>>(new Set());
  /** Books that could be this one, and the one the reader chose. Never inferred — always asked. */
  const [candidates, setCandidates] = useState<BookRow[]>([]);
  const [bindTo, setBindTo] = useState<string | null>(null);
  const [openLayer, setOpenLayer] = useState<LayerKey | null>(null);
  const [reading, setReading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<DepositOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  /**
   * THE BOOK'S FACE, drawn out of the deposit itself.
   *
   * The sender's sheet shows the cover off his own shelf. The receiver has never seen this book, so his
   * copy has to come from the file — `deposit_member` reads exactly that one entry and nothing else.
   * An object URL rather than a data URL: no base64 pass over a few hundred kilobytes, and it is
   * revoked the moment the sheet is finished with it.
   */
  const [cover, setCover] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const text = await depositInspect(path);
        const insp = inspectDeposit(text);
        if (!alive) return;
        setInspection(insp);
        if (!insp.ok) return;
        // EVERYTHING IS KEPT WHEN IT ARRIVES, and the receiver unbinds — the design's own sentence:
        // "a sheaf you unbind until only what you want is left". The summary below always states
        // exactly what is about to be added, so nothing is taken quietly.
        const m = insp.manifest;
        setSelection({
          highlights: new Set(m.marks.highlights.map((_, i) => String(i))),
          notes: new Set(m.marks.notes.map((_, i) => String(i))),
          references: new Set(m.marks.references.map((_, i) => String(i))),
          replacements: new Set(m.marks.replacements.map((_, i) => String(i))),
        });
        // Do they already hold this exact file? Identity is the content hash, so this is exact.
        const books = await libraryListBooks({ sort: "title", order: "asc" }).catch(() => [] as BookRow[]);
        const found = books.find((b) => b.id === m.book.hash) ?? null;
        if (!alive) return;
        setBook(found);
        if (!found && !m.book.file) {
          // A DIFFERENT COPY, OFFERED AS A QUESTION. Folded title and author are what the library's own
          // search matches on, so the candidates are the ones the reader would find by searching for it
          // themselves. Sard never picks: binding to the wrong book would attach a stranger's marks to
          // an unrelated text, and only the reader can rule that out.
          const fold = (x: string | null | undefined) =>
            (x ?? "").normalize("NFKC").replace(/[ً-ٟـ]/g, "").toLowerCase().trim();
          const wantT = fold(m.book.title);
          const wantA = fold(m.book.author);
          const near = books.filter((b) => {
            const t = fold(b.title);
            if (!wantT || !t) return false;
            const titleClose = t === wantT || t.includes(wantT) || wantT.includes(t);
            if (!titleClose) return false;
            const a = fold(b.author);
            return !wantA || !a || a === wantA || a.includes(wantA) || wantA.includes(a);
          });
          setCandidates(near.slice(0, 6));
        }
        if (found) {
          const [refs, reps] = await Promise.all([
            refsForBook(found.id).catch(() => [] as RefRow[]),
            repsForBook(found.id).catch(() => [] as RepRow[]),
          ]);
          if (alive) setMine({ refs, reps });
        }
      } catch (e) {
        if (alive) setError(String(e));
      }
    })();
    return () => {
      alive = false;
    };
  }, [path]);

  const manifest: DepositManifest | null = inspection?.ok ? inspection.manifest : null;

  const bookState: BookState = book ? "same" : manifest?.book.file ? "brings" : "absent";

  // Fetched once the manifest names a cover, and never before: a deposit carrying none simply has no
  // face to show, and the header closes over the gap rather than holding a space for it.
  const coverMember = manifest?.book.cover ?? null;
  useEffect(() => {
    if (!coverMember) return;
    let url: string | null = null;
    let alive = true;
    (async () => {
      try {
        const bytes = await depositMember(path, coverMember);
        if (!alive || !bytes.length) return;
        const ext = coverMember.slice(coverMember.lastIndexOf(".") + 1).toLowerCase();
        const type =
          ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : ext === "gif" ? "image/gif" : "image/jpeg";
        url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type }));
        setCover(url);
      } catch {
        // A cover that will not read is not a failed import — the sheet simply has no face to show.
      }
    })();
    return () => {
      alive = false;
      if (url) URL.revokeObjectURL(url);
      setCover(null);
    };
  }, [path, coverMember]);

  // A phrase the receiver already glosses or replaces. The comparison is the folded phrase — the same
  // key the schema itself uses for "one rule per phrase per book".
  const clashes = useMemo(() => {
    const refs = new Map(mine.refs.map((r) => [r.phrase_fold, r.note]));
    const reps = new Map(mine.reps.map((r) => [r.phrase_fold, r.replacement]));
    return { refs, reps };
  }, [mine]);

  const slips: LayerSlips = useMemo(() => {
    const m = manifest;
    if (!m) return { highlights: [], notes: [], references: [], replacements: [] };
    return {
      highlights: m.marks.highlights.map((h, i) => ({
        id: String(i),
        text: h.text ?? "",
        place: h.chapter_label,
      })),
      notes: m.marks.notes.map((n, i) => ({
        id: String(i),
        text: n.title || n.body,
        under: n.title ? n.body : null,
        place: n.chapter_label,
      })),
      references: m.marks.references.map((r, i) => ({
        id: String(i),
        text: r.phrase,
        under: r.note,
        place: t("dep.wholeBook"),
        clash: clashes.refs.get(r.phrase_fold) ?? null,
        taking: takeTheirs.has(`references:${i}`),
      })),
      replacements: m.marks.replacements.map((r, i) => ({
        id: String(i),
        text: r.phrase,
        under: r.replacement,
        place: t("dep.wholeBook"),
        clash: clashes.reps.get(r.phrase_fold) ?? null,
        taking: takeTheirs.has(`replacements:${i}`),
      })),
    };
  }, [manifest, clashes, takeTheirs, t]);

  // HIS MARKS ARE ALL DRAWN. The map is built from the manifest's own sections, and what is filled is
  // what the receiver kept — so unbinding hollows a band instead of emptying the map.
  const map = useMemo(() => {
    if (!manifest) return null;
    const plan: DepositPlan = {
      book: {
        hash: manifest.book.hash,
        format: manifest.book.format,
        title: manifest.book.title,
        author: manifest.book.author,
        language: manifest.book.language,
        dir: manifest.book.dir,
        size_bytes: manifest.book.size_bytes,
      },
      spine_count: manifest.book.spine_count,
      book_bytes: 0,
      cover_bytes: 0,
      book_source: null,
      cover_source: null,
      book_member: null,
      cover_member: null,
      sections: [
        ...manifest.marks.highlights.map((h, i) => ({
          kind: "highlight" as const,
          id: String(i),
          section: h.section,
          section_index: h.section_index,
        })),
        ...manifest.marks.notes.map((n, i) => ({
          kind: "note" as const,
          id: String(i),
          section: n.section,
          section_index: n.section_index,
        })),
      ],
      counts: {
        highlights: manifest.marks.highlights.length,
        notes: manifest.marks.notes.length,
        references: manifest.marks.references.length,
        replacements: manifest.marks.replacements.length,
      },
    };
    return buildMap({
      plan,
      bound: selection,
      referenceIds: [...selection.references],
      replacementIds: [...selection.replacements],
    });
  }, [manifest, selection]);

  const kept = LAYERS.reduce((n, k) => n + selection[k].size, 0);

  // THE BOOK IS ALSO SOMETHING TO TAKE. Counting only marks left a deposit that carries a book the
  // reader does not own — a book and a letter, nothing else — with its one action disabled and labelled
  // "take nothing", so the book could not be accepted at all. `brings` is exactly that case: the file
  // travelled and the shelf does not have it.
  const bookArrives = bookState === "brings";

  const accept = () => ({
    highlights: [...selection.highlights].map(Number),
    notes: [...selection.notes].map(Number),
    references: [...selection.references].map((i) => ({
      index: Number(i),
      take_theirs: takeTheirs.has(`references:${i}`),
    })),
    replacements: [...selection.replacements].map((i) => ({
      index: Number(i),
      take_theirs: takeTheirs.has(`replacements:${i}`),
    })),
  });

  const take = async () => {
    if (!manifest) return;
    setError(null);
    setBusy(true);
    try {
      const text = await depositInspect(path); // the bytes as they are on disk, not a re-serialised copy
      const outcome = await depositCommit(path, text, accept(), bindTo);
      setDone(outcome);
      // THE SHELF IS OUT OF DATE THE MOMENT THIS RETURNS. Books and marks went straight into the
      // database, so the library is told to refresh through its own loaders — measured: without this
      // the book was in the library, with its cover, and simply not drawn until the next reload.
      useIncomingDeposit.getState().noteReceived();
    } catch (e) {
      const code = String(e);
      setError(code.startsWith("dep.err.") ? t(code.split(":")[0] as never) : code);
    } finally {
      setBusy(false);
    }
  };

  const sender = manifest?.sender.name || manifest?.inscription.signed || "—";

  const bookLine =
    bookState === "same"
      ? t("dep.recv.haveBook", { name: sender })
      : bookState === "brings"
        ? t("dep.recv.bringsBook", { name: sender })
        : t("dep.recv.noBook", { name: sender });

  // WHAT WILL AND WILL NOT LAND, said before anything is taken.
  // FOUR STATES, FOUR SENTENCES. «نسختك» — YOUR copy — is only true when you already hold the book.
  // When the deposit is bringing it, the copy the marks fit is the one travelling with it, and saying
  // "your copy" told a reader he owned a book he had just deleted.
  const placement =
    bookState === "same"
      ? t("dep.recv.willPlace")
      : bookState === "brings"
        ? t("dep.recv.willPlaceBrought")
        : bindTo
          ? t("dep.recv.mayNotPlace")
          : t("dep.recv.noBookYet");

  let body: React.ReactNode;
  if (error && !manifest) {
    body = (
      <div className="dep-done">
        <h2>{t("dep.recv.eyebrow")}</h2>
        <p className="dep-error">{error}</p>
        <div className="dep-actions">
          <button type="button" className="dep-btn" onClick={onClose}>
            {t("dep.close")}
          </button>
        </div>
      </div>
    );
  } else if (inspection && !inspection.ok) {
    // A REFUSAL IN WORDS. The same code reaches the reader whichever side refused it.
    body = (
      <div className="dep-done">
        <Icon name="deposit" size="md" />
        <h2>{t("dep.recv.eyebrow")}</h2>
        <p className="dep-error">{t(inspection.refusal.code as never)}</p>
        <div className="dep-actions">
          <button type="button" className="dep-btn" onClick={onClose}>
            {t("dep.close")}
          </button>
        </div>
      </div>
    );
  } else if (done) {
    const parts: string[] = [];
    const total = (c: DepositOutcome["applied"]) => c.highlights + c.notes + c.references + c.replacements;
    if (total(done.applied)) parts.push(t("dep.recv.applied", { n: localeNum(total(done.applied), lang) }));
    if (total(done.skipped_existing))
      parts.push(t("dep.recv.skipped", { n: localeNum(total(done.skipped_existing), lang) }));
    if (total(done.unplaced)) parts.push(t("dep.recv.unplaced", { n: localeNum(total(done.unplaced), lang) }));
    if (total(done.kept_mine)) parts.push(t("dep.recv.keptMine", { n: localeNum(total(done.kept_mine), lang) }));
    body = (
      <div className="dep-done">
          {/* THE BOOK'S OWN FACE LEADS THE ENDING, as the reference draws it: a completion state
              is a composition, not a caption under a mark. The cover is the one already read out
              of the deposit for the sheet above, so it costs nothing. A deposit carrying no cover
              keeps the deposit's own emblem instead. */}
          {cover ? <img className="dep-done-cover" src={cover} alt="" /> : <Icon name="deposit" size="md" />}
        {/* WHAT ACTUALLY HAPPENED, IN ITS OWN WORDS. A book went to the LIBRARY — saying it was added
            to your reading names the wrong place. Marks went to the archive, credited to the READER who
            sent them, who is a different person from whoever wrote the book. */}
        <h2>
          {done.already_received
            ? t("dep.recv.eyebrow")
            : done.book_imported
              ? t("dep.recv.doneTitleBook")
              : t("dep.recv.doneTitle")}
        </h2>
        <p className="dep-note">
          {done.already_received
            ? t("dep.recv.already")
            : done.book_imported
              ? t("dep.recv.doneBodyBook", { name: sender })
              : t("dep.recv.doneBody", { name: sender })}
        </p>
        {!done.already_received && parts.length > 0 && (
          <div className="dep-parts">
            {parts.map((p, i) => (
              <span key={i}>{p}</span>
            ))}
          </div>
        )}
        <div className="dep-actions">
          <button
            type="button"
            className="dep-btn dep-btn-primary"
            onClick={() => {
              // A BOOK GOES TO THE LIBRARY; MARKS GO TO THE ARCHIVE. The archive is notes and
              // highlights — the right destination for what you kept, and the wrong one for a book
              // you were just given. The sheet closes either way; the request outlives it, because
              // the library may still have to be reached first.
              const store = useIncomingDeposit.getState();
              if (done.already_received) {
                /* nothing arrived — there is nothing to go and see */
              } else if (done.book_imported && done.book_id) {
                useBookDetailsRequest.getState().ask(done.book_id);
              } else {
                store.askArchive();
              }
              onClose();
            }}
          >
            {done.book_imported ? t("dep.recv.donePrimaryBook") : t("dep.recv.donePrimary")}
          </button>
        </div>
      </div>
    );
  } else if (!manifest) {
    body = <p className="dep-note">…</p>;
  } else {
    body = (
      <>
        <header className="dep-head">
          {/* THE COVER LEADS, exactly as it does on the sending side: first in DOM order, so it sits
              beside the title on the reading side — right in Arabic, left in English. */}
          <div className="dep-head-row">
            {cover && <img className="dep-cover" src={cover} alt="" />}
            <div className="dep-head-text">
              {/* THE MARK STANDS WITH THE WORDS. Identity is carried by the accent and by the deposit's
                  own emblem, not by type size — so the line registers at a glance while the book's
                  title stays the largest thing on the sheet. */}
              <span className="dep-eyebrow">
                <Icon name="deposit" size="sm" />
                {t("dep.recv.eyebrow")}
              </span>
              <h2 className="dep-title">{manifest.book.title}</h2>
              {manifest.book.author && <span className="dep-note">{manifest.book.author}</span>}
              {manifest.book.spine_count ? (
                <span className="dep-chapters">
                  {t("dep.chapters", { n: localeNum(manifest.book.spine_count, lang) })}
                </span>
              ) : null}
            </div>
          </div>
          <p className="dep-bookline dep-recv-book" data-state={bookState}>
            {bookLine}
          </p>
          <p className="dep-note">{placement}</p>
          {/* THE DIFFERENT-COPY CHOICE. It sits with the book line because it answers the same
              question, and it is a question: the sender's marks will only land where this reader's own
              text agrees, so a wrong answer costs unplaced marks rather than misplaced ones. */}
          {bookState === "absent" && candidates.length > 0 && (
            <div className="dep-copies">
              <span className="dep-label">{t("dep.recv.chooseCopy")}</span>
              <div className="dep-copy-list">
                {candidates.map((b) => (
                  <button
                    key={b.id}
                    type="button"
                    className="dep-copy"
                    data-on={bindTo === b.id ? "1" : undefined}
                    onClick={() => setBindTo((prev) => (prev === b.id ? null : b.id))}
                  >
                    <span className="dep-copy-title">{b.title}</span>
                    {b.author && <span className="dep-copy-author">{b.author}</span>}
                  </button>
                ))}
              </div>
              {bindTo && <p className="dep-note">{t("dep.recv.copyNote")}</p>}
            </div>
          )}
          {/* WHAT STAYS WITH THE SENDER. Said plainly, because the absence of a thing is invisible. */}
          <p className="dep-note">{t("dep.recv.localOnly")}</p>
        </header>

        {manifest.inscription.text.trim() && (
          <section className="dep-letter">
            <span className="dep-label">{t("dep.recv.letterLabel")}</span>
            <p className="dep-letter-text">{manifest.inscription.text}</p>
            {manifest.inscription.signed && (
              <p className="dep-letter-sign">— {manifest.inscription.signed}</p>
            )}
          </section>
        )}

        {/* His map, in his voice — and the same press that takes a layer below takes it here. */}
        {map && (
          <DepositMap
            map={map}
            marks={kept}
            labelKey="dep.recv.mapLabel"
            noteKey="dep.recv.mapNote"
            possessive="theirs"
            onSetLayer={(k, on) =>
              setSelection((s) => ({ ...s, [k]: on ? new Set(slips[k].map((x) => x.id)) : new Set() }))
            }
          />
        )}

        <div className="dep-sheaf-bar">
          <button type="button" className="dep-chip" onClick={() => setReading(true)}>
            <Icon name="bookOpen" size="sm" />
            {t("dep.recv.readLabel")}
          </button>
        </div>

        <DepositLayers
          slips={slips}
          selection={selection}
          openLayer={openLayer}
          onOpen={setOpenLayer}
          possessive="theirs"
          labelKey="dep.recv.sheafLabel"
          onSetLayer={(k, on) =>
            setSelection((s) => ({ ...s, [k]: on ? new Set(slips[k].map((x) => x.id)) : new Set() }))
          }
          onTakeTheirs={(k, id) =>
            setTakeTheirs((prev) => {
              const key = `${k}:${id}`;
              const next = new Set(prev);
              if (next.has(key)) next.delete(key);
              else next.add(key);
              return next;
            })
          }
          onToggleMark={(k, id) =>
            setSelection((s) => {
              const next = new Set(s[k]);
              if (next.has(id)) next.delete(id);
              else next.add(id);
              return { ...s, [k]: next };
            })
          }
        />

        <footer className="dep-foot">
          <div className="dep-summary">
            <span className="dep-label">{t("dep.recv.sumLabel")}</span>
            {kept > 0 ? (
              <span className="dep-parts">
                {LAYERS.filter((k) => selection[k].size > 0).map((k) => (
                  <span key={k}>
                    {t(`dep.part.${k}` as never, { n: localeNum(selection[k].size, lang) })}
                  </span>
                ))}
              </span>
            ) : (
              <span className="dep-note">{t("dep.recv.none")}</span>
            )}
          </div>
          {error && <p className="dep-error">{error}</p>}
          <div className="dep-actions">
            <button
              type="button"
              className="dep-btn dep-btn-primary dep-btn-wide"
              onClick={() => void take()}
              disabled={busy || (kept === 0 && !bookArrives)}
            >
              {/* A BOOK TAKES A MOMENT — measured at roughly a second for a large one, and the file is
                  verified, unpacked, hashed and parsed in that time. The control said nothing while it
                  worked, so the sheet read as frozen; it now says what it is doing. */}
              {busy
                ? t("dep.recv.ctaBusy")
                : kept > 0
                  ? t("dep.recv.cta")
                  : bookArrives
                    ? t("dep.recv.ctaBook")
                    : t("dep.recv.ctaEmpty")}
            </button>
            <button type="button" className="dep-btn dep-btn-quiet" onClick={onClose}>
              {t("dep.cancel")}
            </button>
          </div>
        </footer>
      </>
    );
  }

  return createPortal(
    <div className="dep-scrim" onClick={onClose}>
      <div
        className="dep-sheet"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={t("dep.recv.eyebrow")}
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
              <DepositRead
                manifest={manifest}
                onClose={() => setReading(false)}
                eyebrowKey="dep.recv.readEyebrow"
                footKey="dep.recv.readFoot"
                letterKey="dep.recv.letterLabel"
              />
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
