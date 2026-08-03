// The update dialog (RAWY-290). It is deliberately NOT a system dialog: an update is a moment where
// the app asks the reader for something, and a generic OS box in the middle of Sard's paper would
// read as an interruption from somewhere else. This wears the same surface as the note editor and
// global settings — chrome ground, theme tokens, a paper-coloured accent action.
//
// It renders four of the store's states; the rest are the rosette's business:
//   available   — current -> new, release notes, "update now?" / "later"
//   downloading — a determinate bar when the server sent a length, indeterminate when it did not
//   installing  — a final beat before the process is replaced
//   error       — one sentence per cause, plus a retry
//
// RTL: every inset is logical, and the progress fill grows from the inline start, so the bar fills
// right-to-left in Arabic without a second code path.

import { useEffect, useRef } from "react";

import { useI18n } from "../../i18n";
import { localeDigits, localeNum } from "../../lib/format";
import { useUpdater } from "../../lib/updater";

/** Bytes -> a short human string. `localeDigits`, not `localeNum`: this is a composed string with a
 *  decimal point, and localeNum rounds to an integer. Unit text comes from the locale. */
function mb(bytes: number, unit: string): string {
  const v = bytes / (1024 * 1024);
  return `${localeDigits(v.toFixed(v < 10 ? 1 : 0))} ${unit}`;
}

export function UpdateDialog() {
  const { t, lang } = useI18n();
  const state = useUpdater((s) => s.state);
  const install = useUpdater((s) => s.install);
  const cancel = useUpdater((s) => s.cancel);
  const dismiss = useUpdater((s) => s.dismiss);
  const cancelRequested = useUpdater((s) => s.cancelRequested);
  const primaryRef = useRef<HTMLButtonElement>(null);

  const open =
    state.k === "available" || state.k === "downloading" || state.k === "installing" || state.k === "error";

  // Focus the primary action when the dialog appears, so it is reachable without hunting for it.
  useEffect(() => {
    if (open) primaryRef.current?.focus();
  }, [open, state.k]);

  // Escape closes — but never mid-install, when there is nothing left to cancel.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (state.k === "installing") return;
      if (state.k === "downloading") cancel();
      else dismiss();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, state.k, cancel, dismiss]);

  if (!open) return null;

  const scrimClick = () => {
    if (state.k === "installing" || state.k === "downloading") return; // never lose a running job to a stray click
    dismiss();
  };

  return (
    <>
      <div className="upd-scrim" onClick={scrimClick} />
      <div className="upd-dialog" role="dialog" aria-modal="true" aria-labelledby="upd-dlg-title">
        {state.k === "available" && (
          <>
            <div className="upd-dlg-eyebrow">{t("upd.eyebrow")}</div>
            <h2 className="upd-dlg-title" id="upd-dlg-title">{t("upd.availableTitle")}</h2>

            <div className="upd-versions">
              <div className="upd-ver">
                <span className="upd-ver-label">{t("upd.current")}</span>
                <span className="upd-ver-num">{localeDigits(state.current)}</span>
              </div>
              <span className="upd-ver-arrow" aria-hidden>→</span>
              <div className="upd-ver upd-ver-new">
                <span className="upd-ver-label">{t("upd.new")}</span>
                <span className="upd-ver-num">{localeDigits(state.version)}</span>
              </div>
            </div>

            {state.notes && (
              <div className="upd-notes">
                <div className="upd-notes-label">{t("upd.notes")}</div>
                <div className="upd-notes-body" dir="auto">{state.notes}</div>
              </div>
            )}

            <p className="upd-ask">{t("upd.ask")}</p>

            <div className="upd-dlg-actions">
              <button className="upd-btn" onClick={dismiss}>{t("upd.later")}</button>
              <button className="upd-btn upd-btn-primary" ref={primaryRef} onClick={install}>
                {t("upd.updateNow")}
              </button>
            </div>
          </>
        )}

        {state.k === "downloading" && (
          <>
            <div className="upd-dlg-eyebrow">{t("upd.eyebrow")}</div>
            <h2 className="upd-dlg-title" id="upd-dlg-title">
              {t("upd.downloading", { v: localeDigits(state.version) })}
            </h2>

            {/* Determinate whenever the server sent a content length; otherwise an honest
                indeterminate sweep rather than a percentage invented from nothing. */}
            <div className={`upd-bar${state.total == null ? " indet" : ""}`}>
              <div
                className="upd-bar-fill"
                style={state.total != null ? { width: `${Math.min(100, (state.received / state.total) * 100)}%` } : undefined}
              />
            </div>
            <div className="upd-bar-meta">
              <span>
                {state.total != null
                  ? `${mb(state.received, t("upd.mb"))} / ${mb(state.total, t("upd.mb"))}`
                  : mb(state.received, t("upd.mb"))}
              </span>
              {state.total != null && (
                <span className="tnum">{localeNum(Math.round((state.received / state.total) * 100), lang)}%</span>
              )}
            </div>

            <div className="upd-dlg-actions">
              <button className="upd-btn" onClick={cancel} disabled={cancelRequested}>
                {cancelRequested ? t("upd.cancelling") : t("upd.cancel")}
              </button>
            </div>
            <p className="upd-fineprint">{t("upd.verifyNote")}</p>
          </>
        )}

        {state.k === "installing" && (
          <>
            <div className="upd-dlg-eyebrow">{t("upd.eyebrow")}</div>
            <h2 className="upd-dlg-title" id="upd-dlg-title">{t("upd.installing")}</h2>
            <div className="upd-installing">
              <span className="spin-ring" aria-hidden />
              <p className="upd-fineprint">{t("upd.installingBody")}</p>
            </div>
          </>
        )}

        {state.k === "error" && (
          <>
            <div className="upd-dlg-eyebrow upd-dlg-eyebrow-warn">{t("upd.problem")}</div>
            <h2 className="upd-dlg-title" id="upd-dlg-title">{t(`upd.err.${state.kind}`)}</h2>
            <p className="upd-fineprint">{t("upd.errFoot")}</p>
            <div className="upd-dlg-actions">
              <button className="upd-btn upd-btn-primary" ref={primaryRef} onClick={dismiss}>
                {t("upd.close")}
              </button>
            </div>
          </>
        )}
      </div>
    </>
  );
}
