// RESILIENCE-1 / WP-1 — the one way Sard shows a failure.
//
// Every book-opening failure and the startup runtime gate render through THIS component, so a new
// failure surface cannot quietly invent a fourth look. It takes a `Classified` (from
// `lib/errors.ts`) and a handler per recovery action, and it renders:
//
//     ⚠  <title — what failed, in the user's language>
//        <body — whose fault it is and what happens next>
//        [ primary action ] [ secondary ] … [ Details ]
//        ▸ Details (collapsed)  →  the raw exception + a copy button
//
// The raw text is behind the disclosure and NOWHERE else. That is the whole rule: the primary UI
// stays human, and the developer detail stays available.

import { useState, type ReactNode } from "react";

import { useI18n } from "../i18n";
import type { Classified, RecoveryAction } from "../lib/errors";

/** One handler per action the caller is willing to offer. An action with no handler is not shown. */
export type ActionHandlers = Partial<Record<Exclude<RecoveryAction, "details">, () => void>>;

const ACTION_LABEL: Record<RecoveryAction, Parameters<ReturnType<typeof useI18n>["t"]>[0]> = {
  retry: "err.act.retry",
  "update-runtime": "err.act.updateRuntime",
  reimport: "err.act.reimport",
  "remove-book": "err.act.removeBook",
  back: "err.act.back",
  details: "err.act.details",
};

export function ErrorCard({
  classified,
  handlers,
  diagnosticsText,
  extra,
}: {
  classified: Classified;
  handlers: ActionHandlers;
  /** The full block the copy button emits. Absent → no copy button (nothing useful to hand over). */
  diagnosticsText?: string;
  /** Extra lines above the actions — the startup gate uses it for the missing-feature list. */
  extra?: ReactNode;
}) {
  const { t } = useI18n();
  const [showDetails, setShowDetails] = useState(false);
  const [copied, setCopied] = useState(false);

  const { presentation: p } = classified;
  // Only actions the caller can actually perform. `details` is handled here, not by the caller.
  const offered = p.actions.filter((a) => a === "details" || handlers[a as keyof ActionHandlers]);

  const copy = () => {
    if (!diagnosticsText) return;
    // `navigator.clipboard` can reject (focus/permissions). A failed copy must not throw into the
    // error card — that would be a failure inside the failure UI.
    void navigator.clipboard?.writeText(diagnosticsText).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1800);
      },
      () => {
        /* leave the button unchanged — the text is on screen and selectable anyway */
      },
    );
  };

  return (
    <div className="reader-error-card" data-fault={p.fault}>
      <div className="reader-error-mark" aria-hidden>
        ⚠
      </div>
      <div className="reader-error-title">{t(p.titleKey)}</div>
      <p className="err-body">{t(p.bodyKey)}</p>
      {extra}

      <div className="reader-error-actions">
        {offered.map((a) =>
          a === "details" ? (
            <button
              key={a}
              className="reader-error-btn err-btn-quiet"
              aria-expanded={showDetails}
              onClick={() => setShowDetails((v) => !v)}
            >
              {t(showDetails ? "err.act.hideDetails" : "err.act.details")}
            </button>
          ) : (
            <button
              key={a}
              className={`reader-error-btn${a === offered[0] ? " primary" : ""}`}
              onClick={handlers[a as keyof ActionHandlers]}
            >
              {t(ACTION_LABEL[a])}
            </button>
          ),
        )}
      </div>

      {showDetails && (
        <div className="err-details">
          <div className="err-details-note">{t("err.detailsNote")}</div>
          {/* The ONLY place raw engine text is ever rendered. */}
          <pre className="reader-error-detail">{diagnosticsText ?? classified.raw}</pre>
          {diagnosticsText && (
            <button className="reader-error-btn err-btn-quiet" onClick={copy}>
              {t(copied ? "err.act.copied" : "err.act.copy")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
