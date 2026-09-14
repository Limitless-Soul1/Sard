// THE LEGAL DOCUMENTS, AFTER THEY HAVE BEEN ACCEPTED.
//
// The gate shows them once. Without this they would then be unreachable — a reader who agreed to
// something in a hurry could never look at it again without leaving the application, and the one
// question a person is most likely to ask afterwards ("what did I agree to, and when?") would have
// no answer inside Sard. That is a poor deal for the reader and a weak record for the project.
//
// It is a READING surface and nothing else: no acceptance, no buttons that decide anything. The
// same generated blocks the gate renders, so the two can never show different text.
import { useEffect, useState } from "react";

import { useI18n } from "../../i18n";
import { settingsGet } from "../../lib/ipc";
import { LEGAL_AT_KEY, LEGAL_KEY } from "./LegalGate";
import { LegalBody } from "./LegalBody";
import {
  LEGAL_CONTENT_HASH,
  LEGAL_PRIVACY,
  LEGAL_REVISION,
  LEGAL_TERMS,
} from "../../legal/content.generated";

export function LegalDocuments() {
  const { t, lang } = useI18n();
  const [page, setPage] = useState<"terms" | "privacy">("terms");
  const [accepted, setAccepted] = useState<string | null>(null);
  const [at, setAt] = useState<string | null>(null);

  useEffect(() => {
    settingsGet(LEGAL_KEY).then((v) => setAccepted(v || null)).catch(() => undefined);
    settingsGet(LEGAL_AT_KEY).then((v) => setAt(v || null)).catch(() => undefined);
  }, []);

  const when = at ? new Date(at) : null;
  const stamp = when && !Number.isNaN(when.getTime())
    ? when.toLocaleDateString(lang === "ar" ? "ar" : "en", { year: "numeric", month: "long", day: "numeric" })
    : null;

  const tab = (k: "terms" | "privacy", label: string) => (
    <button
      className={`libd-menu-item${page === k ? " is-on" : ""}`}
      aria-pressed={page === k}
      onClick={() => setPage(k)}
      style={{ flex: 1, justifyContent: "center", padding: "8px 10px", borderRadius: "var(--r-sm)", font: "600 .8125rem var(--ui-font)" }}
    >
      {label}
    </button>
  );

  return (
    <div className="gs-legal" dir={lang === "ar" ? "rtl" : "ltr"}>
      <div style={{ display: "flex", gap: 6, marginBottom: "var(--sp-4)" }}>
        {tab("terms", t("legal.tab.terms"))}
        {tab("privacy", t("legal.tab.privacy"))}
      </div>
      <div
        className="libd-quietscroll"
        tabIndex={0}
        style={{
          maxHeight: 340, overflowY: "auto", padding: "var(--sp-5)",
          background: "var(--paper-bg)", border: "1px solid var(--chrome-border)",
          borderRadius: "var(--r-md)",
        }}
      >
        <LegalBody doc={page === "terms" ? LEGAL_TERMS : LEGAL_PRIVACY} lang={lang} />
      </div>
      {/* THE RECORD, stated plainly: what this build carries, and what this installation agreed to. */}
      <div style={{ marginTop: "var(--sp-4)", font: "500 .6875rem/1.7 var(--ui-font)", color: "var(--faint)" }}>
        <div>{t("legal.inBuild", { rev: LEGAL_REVISION })}</div>
        {accepted && (
          <div>
            {stamp
              ? t("legal.acceptedOn", { rev: accepted, date: stamp })
              : t("legal.acceptedRev", { rev: accepted })}
          </div>
        )}
        <div style={{ opacity: 0.75 }}>{LEGAL_CONTENT_HASH}</div>
      </div>
    </div>
  );
}
