// THE ONE THING SARD ASKS BEFORE IT LETS YOU IN.
//
// WHAT IT IS. When the Terms and the Privacy Policy change in a way that needs agreement, this
// shows them and asks for it. It is the only surface in Sard that cannot be waved away: Escape does
// nothing, a press on the scrim does nothing, and the accept button is the single way past it.
// Everything else in the application treats a dismissal as an answer; a legal gate that can be
// dismissed has not asked anything.
//
// WHAT DECIDES WHETHER IT APPEARS is one comparison, and deliberately not a boolean. The build
// carries `LEGAL_REVISION` — the exact pair of documents it contains — and the installation
// remembers the revision it last accepted. Missing, or different, and the gate opens; equal, and it
// never does. A future revision therefore asks once and only once, with no timestamps, no install
// detection, and nothing to migrate.
//
// THE TEXT IS NOT WRITTEN HERE. It is generated from the sard-legal repository, which owns it, and
// the build gate re-derives it to prove the two still agree. Nothing in this file may alter a word.
import { useEffect, useState } from "react";

import { Icon } from "../../components/Icon";
import { LegalBody } from "./LegalBody";
import { useI18n } from "../../i18n";
import { settingsGet, settingsSet } from "../../lib/ipc";
import { useDialog } from "../../components/useDialog";
import { LEGAL_PRIVACY, LEGAL_REVISION, LEGAL_TERMS } from "../../legal/content.generated";

/** The key that answers "has this installation accepted the revision this build carries?" */
export const LEGAL_KEY = "legal_accepted_revision";
/**
 * WHEN it was accepted, beside WHAT was accepted.
 *
 * The gate does not read this and never will — it decides on the revision alone, so a missing
 * or unreadable timestamp can never keep a reader out or let one past. It exists so that
 * "this installation accepted terms-1.1+privacy-1.2" can be completed with "on this date",
 * which is the difference between a record and an assertion.
 */
export const LEGAL_AT_KEY = "legal_accepted_at";

export function LegalGate() {
  const { t, lang } = useI18n();
  /** null = not looked yet. A gate must never flash before it knows whether it is needed. */
  const [accepted, setAccepted] = useState<string | null | undefined>(undefined);
  const [page, setPage] = useState<"terms" | "privacy">("terms");
  const [ack, setAck] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    settingsGet(LEGAL_KEY)
      .then((v) => { if (alive) setAccepted(v ?? null); })
      // A read that fails must not let the reader past — treat it as "not accepted" and ask.
      .catch(() => { if (alive) setAccepted(null); });
    return () => { alive = false; };
  }, []);

  // NO `onDismiss`. The hook's own contract: omit it and Escape does nothing rather than choosing
  // on the reader's behalf. That is exactly what a gate that must be answered wants.
  const dlg = useDialog({ label: t("legal.title"), initialFocus: "none" });

  if (accepted === undefined || accepted === LEGAL_REVISION) return null;

  const accept = async () => {
    setSaving(true);
    try {
      await settingsSet(LEGAL_KEY, LEGAL_REVISION);
      // Written after the revision and never awaited for the decision: the acceptance is the
      // revision, and a clock that fails must not undo one.
      void settingsSet(LEGAL_AT_KEY, new Date().toISOString()).catch(() => undefined);
      setAccepted(LEGAL_REVISION);
    } catch {
      // It could not be written, so it was not accepted. Staying open is the honest outcome: the
      // alternative is letting the reader through on an acceptance no restart would remember.
      setSaving(false);
    }
  };

  const doc = page === "terms" ? LEGAL_TERMS : LEGAL_PRIVACY;
  const tab = (k: "terms" | "privacy", label: string) => (
    <button
      className={`libd-menu-item${page === k ? " is-on" : ""}`}
      aria-pressed={page === k}
      onClick={() => setPage(k)}
      style={{
        flex: 1, justifyContent: "center", padding: "8px 10px", borderRadius: "var(--r-sm)",
        font: "600 .8125rem var(--ui-font)",
      }}
    >
      {label}
    </button>
  );

  return (
    <div
      className="libd-root"
      style={{
        position: "fixed", inset: 0, zIndex: 400,
        display: "grid", placeItems: "center", padding: "var(--sp-6)",
        background: "rgba(0,0,0,.46)",
        animation: "sard-fade .14s ease-out",
      }}
      // A PRESS ON THE SCRIM IS NOT AN ANSWER. Every other surface in Sard closes here; this one
      // must not, so the press is stopped rather than passed to anything that would act on it.
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <div
        className="libd-dialog"
        ref={dlg.ref}
        {...dlg.props}
        dir={lang === "ar" ? "rtl" : "ltr"}
        style={{
          width: "min(560px,100%)",
          // A CAP OF ITS OWN, NOT THE WINDOW'S.
          //
          // `calc(100vh - 32px)` bounded it — it stopped running off the bottom — but bounding is
          // not sizing: at 1440x900 it then stood 868px tall and at 1280x800 768px, which is a
          // legal page with the application hidden behind it rather than a dialog asking something.
          // 520px is the size this dialog wants; the viewport term only takes over on a window too
          // short to give it that, and the legal region is what absorbs the difference either way.
          maxHeight: "min(520px, calc(100vh - 2 * var(--sp-6, 16px)))",
          display: "flex", flexDirection: "column",
          background: "var(--chrome-bg)", border: "1px solid var(--chrome-border)",
          borderRadius: "var(--r-xl)", boxShadow: "var(--sh4)",
          animation: "sard-rise .16s ease-out",
        }}
      >
        <div style={{ flex: "none", padding: "var(--sp-6) var(--sp-6) var(--sp-4)" }}>
          <div style={{ font: "600 .6875rem var(--ui-font)", color: "var(--faint)", marginBottom: 4 }}>
            {t("legal.eyebrow")}
          </div>
          <h2 id={dlg.titleId} style={{ margin: 0, font: "600 1.0625rem var(--ui-font)", color: "var(--text)" }}>
            {t("legal.title")}
          </h2>
          <p style={{ margin: "6px 0 0", font: "400 .8125rem/1.55 var(--ui-font)", color: "var(--muted)" }}>
            {t("legal.intro")}
          </p>
        </div>

        {/* BOTH DOCUMENTS ARE HERE, not one here and one behind a link. Acceptance covers the pair,
            so the pair has to be readable before it is given. */}
        <div style={{ flex: "none", display: "flex", gap: 6, padding: "0 var(--sp-6) var(--sp-4)" }}>
          {tab("terms", t("legal.tab.terms"))}
          {tab("privacy", t("legal.tab.privacy"))}
        </div>

        <div
          className="libd-quietscroll"
          tabIndex={0}
          aria-label={page === "terms" ? t("legal.tab.terms") : t("legal.tab.privacy")}
          style={{
            flex: "1 1 auto", minHeight: 0, overflowY: "auto",
            margin: "0 var(--sp-6)", padding: "var(--sp-5) var(--sp-5)",
            background: "var(--paper-bg)", border: "1px solid var(--chrome-border)",
            borderRadius: "var(--r-md)",
          }}
        >
          <LegalBody doc={doc} lang={lang} />
        </div>

        <div style={{ flex: "none", padding: "var(--sp-5) var(--sp-6) var(--sp-6)" }}>
          {/* THE ACKNOWLEDGEMENT IS ITS OWN ACT. The button alone would be ambiguous about what is
              being agreed to; this names both documents and the revision being accepted. */}
          <label className="legal-ack">
            <input
              className="legal-ack-input"
              type="checkbox"
              checked={ack}
              onChange={(e) => setAck(e.target.checked)}
            />
            <span className="legal-ack-box" aria-hidden>
              <Icon name="check" size="sm" />
            </span>
            <span className="legal-ack-text">{t("legal.ack")}</span>
          </label>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: "var(--sp-5)" }}>
            <span style={{ font: "500 .6875rem var(--ui-font)", color: "var(--faint)" }}>{LEGAL_REVISION}</span>
            <button
              className="libd-btn-primary"
              disabled={!ack || saving}
              onClick={() => void accept()}
              style={{
                marginInlineStart: "auto", padding: "9px 20px", borderRadius: "var(--r-md)",
                font: "600 .875rem var(--ui-font)", cursor: ack && !saving ? "pointer" : "default",
                opacity: ack && !saving ? 1 : 0.5,
              }}
            >
              {t("legal.accept")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
