// MODEL TERMS, BEFORE THE DOWNLOAD THAT NEEDS THEM.
//
// Built as Sard's own terms gate is (features/legal/LegalGate.tsx): the documents in full in a scroll region, an
// acknowledgement that starts unticked, the revision named beside the one primary. ONE DIFFERENCE: this can be
// declined — "Not now", Escape and the scrim all close it, and closing records nothing and fetches nothing. Sard needs
// its own terms answered; a model does not.
//
// THE TEXT IS THE BACKEND'S. The documents and their revision come from `translation_licence_terms`, and the
// acceptance sends back the revision shown — which the backend accepts only if it is the current one. So what is
// read here is exactly what is checked there. The backend refuses every acceptance while it carries no text, and
// this dialog is opened only when it does.
import { useState } from "react";

import { Icon } from "../../../components/Icon";
import { useDialog } from "../../../components/useDialog";
import { useI18n } from "../../../i18n";
import type { TermsView } from "./api";

export function LicenceDialog({ name, terms, stale, onDecline, onAccept }: {
  name: string;
  terms: TermsView;
  /** An earlier revision was accepted: the terms changed since. */
  stale: boolean;
  onDecline: () => void;
  /** Record the acceptance of `terms.revision`, then download. Rejects if either fails; the dialog stays open. */
  onAccept: (revision: string) => Promise<void>;
}) {
  const { t, lang } = useI18n();
  const [ack, setAck] = useState(false);
  const [saving, setSaving] = useState(false);
  const dlg = useDialog({ onDismiss: onDecline, label: t("translation.licence.a.title", { name }), initialFocus: "none" });

  const accept = async () => {
    setSaving(true);
    try {
      await onAccept(terms.revision);
    } catch {
      setSaving(false);
    }
  };

  return (
    <div
      className="libd-root"
      style={{ position: "fixed", inset: 0, zIndex: 400, display: "grid", placeItems: "center", padding: "var(--sp-6)", background: "rgba(0,0,0,.34)" }}
      onClick={onDecline}
    >
      <div
        className="libd-dialog"
        ref={dlg.ref}
        {...dlg.props}
        dir={lang === "ar" ? "rtl" : "ltr"}
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(560px,100%)", maxHeight: "min(560px, calc(100vh - 2 * var(--sp-6, 16px)))", display: "flex", flexDirection: "column",
          background: "var(--chrome-bg)", border: "1px solid var(--chrome-border)", borderRadius: "var(--r-xl)", boxShadow: "var(--sh4)",
          animation: "sard-rise .16s ease-out",
        }}
      >
        <div style={{ flex: "none", padding: "var(--sp-6) var(--sp-6) var(--sp-4)" }}>
          <div style={{ font: "600 .6875rem var(--ui-font)", color: "var(--faint)", marginBottom: 4 }}>{t("translation.licence.a.eyebrow")}</div>
          <h2 id={dlg.titleId} style={{ margin: 0, font: "600 1.0625rem var(--ui-font)", color: "var(--text)" }}>
            {t("translation.licence.a.title", { name })}
          </h2>
          {stale && <p className="edit-cover-error" style={{ margin: "8px 0 0" }}>{t("translation.licence.a.changed")}</p>}
        </div>

        <div
          className="libd-quietscroll"
          tabIndex={0}
          style={{
            flex: "1 1 auto", minHeight: 0, overflowY: "auto", margin: "0 var(--sp-6)", padding: "var(--sp-5)",
            background: "var(--paper-bg)", border: "1px solid var(--chrome-border)", borderRadius: "var(--r-md)",
          }}
        >
          {terms.documents.map((d) => (
            <section key={d.source} dir="ltr" lang="en" style={{ marginBottom: "var(--sp-6)", textAlign: "start" }}>
              <h3 style={{ margin: "0 0 6px", font: "600 .875rem var(--ui-font)", color: "var(--text)" }}>{d.title}</h3>
              <div style={{ font: "400 .6875rem var(--ui-font)", color: "var(--faint)", marginBottom: 8, overflowWrap: "anywhere" }}>{d.source}</div>
              <div style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", font: "400 .78125rem/1.6 var(--ui-font)", color: "var(--text)" }}>{d.text}</div>
            </section>
          ))}
        </div>

        <div style={{ flex: "none", padding: "var(--sp-5) var(--sp-6) var(--sp-6)" }}>
          <label className="legal-ack">
            <input className="legal-ack-input" type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
            <span className="legal-ack-box" aria-hidden>
              <Icon name="check" size="sm" />
            </span>
            <span className="legal-ack-text">{t("translation.licence.a.ack")}</span>
          </label>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: "var(--sp-5)" }}>
            <span dir="ltr" style={{ font: "500 .6875rem var(--ui-font)", color: "var(--faint)" }}>{terms.revision}</span>
            <button className="reader-error-btn err-btn-quiet" onClick={onDecline} style={{ marginInlineStart: "auto" }}>
              {t("translation.licence.a.decline")}
            </button>
            <button className="upd-btn upd-btn-primary" disabled={!ack || saving} onClick={() => void accept()}>
              {t("translation.licence.a.acceptAndDownload")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
