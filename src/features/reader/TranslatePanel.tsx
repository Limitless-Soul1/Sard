// Page-translation panel (a side panel that translates the current page's text).
//
// Mirrors the SearchPanel shell (rp-lead slide-in, rp-head with a close button) so it lands in the
// same physical slot and behaves like the other reader panels. The difference is the body: instead
// of a query + results it shows the translation of the page the reader is on, with a re-translate
// button that re-extracts the current page (so the panel stays current after a page turn).
//
// Non-destructive by design: it never touches the book iframe. The page text is read out via
// FoliateController.currentPageText(), sent through the existing translate() IPC, and rendered here.
// The book page is the hero; this panel is furniture beside it.

import { useCallback, useEffect, useRef, useState } from "react";

import { useI18n } from "../../i18n";
import type { FoliateController } from "../../reader-engine/FoliateController";
import { translate, translatorSettingsGet } from "../../lib/ipc";

interface Props {
  open: boolean;
  onClose: () => void;
  bookTitle: string | null;
  /** The controller, used to extract the current page's text on each translate. */
  ctrlRef: React.RefObject<FoliateController | null>;
}

type State =
  | { k: "idle" }
  | { k: "loading" }
  | { k: "ok"; text: string; src: string | null }
  | { k: "err"; msg: string };

export function TranslatePanel({ open, onClose, bookTitle, ctrlRef }: Props) {
  const { t, dir } = useI18n();
  const [state, setState] = useState<State>({ k: "idle" });
  // Whether translation is enabled at all. The chrome button that opens this panel is itself gated
  // on enabled, but a reader could toggle it off while the panel is open — guard the action too.
  const [enabled, setEnabled] = useState(false);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    translatorSettingsGet().then((s) => setEnabled(s.enabled)).catch(() => setEnabled(false));
  }, [open]);

  const run = useCallback(() => {
    const ctrl = ctrlRef.current;
    if (!ctrl) return;
    const text = ctrl.currentPageText();
    if (!text.trim()) {
      setState({ k: "err", msg: t("tr.page.empty") });
      return;
    }
    setState({ k: "loading" });
    translate(text)
      .then((r) => setState({ k: "ok", text: r.text, src: r.detected_source }))
      .catch((e) => setState({ k: "err", msg: String(e) }));
  }, [ctrlRef, t]);

  // On open, kick off a translation immediately so the panel isn't an empty frame waiting for a click.
  useEffect(() => {
    if (open) run();
    // Re-run on open only; subsequent page turns are the reader's to trigger (the Re-translate button).
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <aside
      className={`reader-panel rp-lead translate-panel${open ? " show" : ""}`}
      dir={dir}
      aria-hidden={!open}
      inert={!open}
    >
      <div className="rp-head">
        <div className="rp-head-titles">
          <span className="rp-title">{t("tr.page.title")}</span>
          <span className="rp-submeta" dir="auto">{bookTitle || t("reader.untitledBook")}</span>
        </div>
        <div className="rp-head-actions">
          <button className="rp-x" onClick={onClose} title={t("panel.close")} aria-label={t("panel.close")}>✕</button>
        </div>
      </div>

      {/* action row: re-translate the current page (re-extracts text, so it tracks page turns). */}
      <div className="tp-actions">
        <button
          className="tp-run"
          onClick={run}
          disabled={!enabled || state.k === "loading"}
        >
          {state.k === "loading" ? <span className="tp-spin" aria-hidden /> : null}
          {state.k === "loading" ? t("tr.page.translating") : t("tr.page.translate")}
        </button>
      </div>

      {/* body */}
      <div className="tp-body" ref={bodyRef}>
        {!enabled && <div className="tp-empty">{t("tr.page.disabled")}</div>}
        {enabled && state.k === "idle" && <div className="tp-empty">{t("tr.page.idle")}</div>}
        {enabled && state.k === "loading" && <div className="tp-loading">{t("tr.page.translating")}</div>}
        {enabled && state.k === "err" && <div className="tp-err">{state.msg}</div>}
        {enabled && state.k === "ok" && (
          <>
            {state.src && <div className="tp-src">{t("tr.source", { lang: state.src })}</div>}
            <div className="tp-result" dir="auto">{state.text}</div>
          </>
        )}
      </div>
    </aside>
  );
}
