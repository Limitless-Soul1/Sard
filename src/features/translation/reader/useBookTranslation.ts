// A book's translation, as the reader sees it: whether it can be translated, its edition, the switch between the
// original and the translation, the Translate action, and what is said when something goes wrong.
//
// The action never downloads or prepares anything: with no ready model it opens Settings → Translation. With one,
// the book is extracted (only when it has no edition for that model yet), its edition made or found, and the job
// started — the section being read first. There is no pause, cancel or progress in this phase; the job's end, and the
// end of its first part, arrive as events, and the shown sections are refreshed then.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useI18n } from "../../../i18n";
import type { TKey } from "../../../i18n/locales/en";
import type { FoliateController } from "../../../reader-engine/FoliateController";
import type { TranslationLayer } from "../../../reader-engine/translationLayer";
import { extractBook, type SourceSection } from "../source/extract";
import { onEditionEvent, readerEdition, readerSection, readerStatus, readerTranslate, type ParagraphView, type ReaderErrorView, type ReaderStatus } from "./api";
import { applyToDocument, clearDocument, showsAlready, type Labels } from "./apply";

export type Mode = "original" | "translation";

export interface Notice {
  key: TKey;
  /** The technical text, behind Details. */
  detail: string | null;
}

/** What the reader says for a refusal or a failure, in approved words. */
export function noticeFor(e: ReaderErrorView): Notice | null {
  switch (e.kind) {
    case "no_ready_model":
      return null;
    case "runtime_changed":
      return { key: "translation.reader.runtimeChanged", detail: e.detail };
    case "busy":
      return { key: "translation.inUse.engine", detail: null };
    case "failed":
      return { key: e.memory ? "translation.fail.memory" : e.engineBusy ? "translation.inUse.engine" : "translation.fail.unknown", detail: e.detail };
  }
}

/** A rejection as a ReaderErrorView: the backend's own, or anything else (a section that could not be read) as a
 *  failure with its text. */
export function asReaderError(e: unknown): ReaderErrorView {
  if (e && typeof e === "object" && "kind" in e) return e as ReaderErrorView;
  return { kind: "failed", memory: false, engineBusy: false, detail: e instanceof Error ? e.message : String(e) };
}

/** The translation view of one edition: each section as it loads, from what is stored now. */
export class Layer implements TranslationLayer {
  private views = new Map<number, ParagraphView[]>();
  private docs = new Map<number, Document>();
  private dead = false;

  constructor(
    private readonly edition: string,
    private readonly labels: Labels,
  ) {}

  apply(doc: Document, index: number): void {
    this.docs.set(index, doc);
    const known = this.views.get(index);
    if (known) applyToDocument(doc, known, this.labels);
    void this.fetch(index);
  }

  clear(doc: Document): void {
    clearDocument(doc);
  }

  /** Read the sections shown again: a job has stored more of them. */
  refresh(): void {
    for (const index of Array.from(this.docs.keys())) void this.fetch(index);
  }

  dispose(): void {
    this.dead = true;
  }

  private async fetch(index: number): Promise<void> {
    let views: ParagraphView[];
    try {
      views = await readerSection(this.edition, index);
    } catch {
      return;
    }
    if (this.dead) return;
    this.views.set(index, views);
    const doc = this.docs.get(index);
    if (!doc?.defaultView) {
      this.docs.delete(index);
      return;
    }
    try {
      // A section shown again from what was known already shows this, unless something was stored for it since:
      // applying it again would take every mark off and lay the whole section out once more, for nothing.
      if (showsAlready(doc, views, this.labels)) return;
      applyToDocument(doc, views, this.labels);
    } catch {
      /* never breaks the page */
    }
  }
}

export function useBookTranslation(bookId: string, controller: () => FoliateController | null, enabled: boolean) {
  const { t } = useI18n();
  const [status, setStatus] = useState<ReaderStatus | null>(null);
  const [mode, setMode] = useState<Mode>("original");
  const [starting, setStarting] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [needsModel, setNeedsModel] = useState(false);
  const layer = useRef<Layer | null>(null);

  // Another book: the original view, and nothing said about the last one.
  useEffect(() => {
    setMode("original");
    setNotice(null);
    setStatus(null);
  }, [bookId]);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    try {
      setStatus(await readerStatus(bookId));
    } catch {
      /* the control stays as it was */
    }
  }, [bookId, enabled]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const labels = useMemo<Labels>(
    () => ({
      review: t("translation.reader.review"),
      reviewHint: t("translation.reader.reviewHint"),
      notTranslated: t("translation.reader.notTranslated"),
      keptOriginal: t("translation.reader.keptOriginal"),
    }),
    [t],
  );

  const edition = status?.edition?.id ?? null;
  useEffect(() => {
    const c = controller();
    if (!c || !enabled) return;
    layer.current?.dispose();
    if (mode === "translation" && edition) {
      layer.current = new Layer(edition, labels);
      c.setTranslationLayer(layer.current);
    } else {
      layer.current = null;
      c.setTranslationLayer(null);
    }
  }, [mode, edition, labels, controller, enabled]);

  // Leaving the book takes the view away with it.
  useEffect(
    () => () => {
      layer.current?.dispose();
      controller()?.setTranslationLayer(null);
    },
    [controller],
  );

  useEffect(() => {
    if (!enabled) return;
    const stop = onEditionEvent((e) => {
      if (e.book !== bookId) return;
      if (e.kind === "failed") setNotice(noticeFor(e.error));
      layer.current?.refresh();
      void refresh();
    });
    return () => {
      void stop.then((un) => un());
    };
  }, [bookId, enabled, refresh]);

  const translate = async () => {
    if (starting) return;
    setNotice(null);
    setStarting(true);
    try {
      const s = await readerStatus(bookId);
      setStatus(s);
      if (!s.model) {
        setNeedsModel(true);
        return;
      }
      let editionId = s.edition && s.edition.model === s.model.id ? s.edition.id : null;
      if (!editionId) {
        const sections = controller()?.bookSections();
        if (!sections) throw new Error("the book is not open");
        editionId = await readerEdition(bookId, await extractBook({ sections: sections as SourceSection[] }));
      }
      const current = controller()?.currentSectionIndex() ?? -1;
      await readerTranslate(bookId, editionId, current >= 0 ? current : null);
      setMode("translation");
      await refresh();
    } catch (e) {
      const err = asReaderError(e);
      if (err.kind === "no_ready_model") setNeedsModel(true);
      else setNotice(noticeFor(err));
    } finally {
      setStarting(false);
    }
  };

  return {
    status,
    mode,
    setMode,
    translate,
    starting,
    notice,
    dismissNotice: () => setNotice(null),
    needsModel,
    closeNeedsModel: () => {
      setNeedsModel(false);
      void refresh();
    },
  };
}
