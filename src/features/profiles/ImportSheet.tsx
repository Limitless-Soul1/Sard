// FRAME 14 — a profile has reached you. FRAME 15 — it was added. FRAME 17 — it could not be read.
//
// PREVIEW FIRST, ALWAYS. Nothing reaches the database until the reader has seen what the file
// contains and said yes. Inspection and commit are separate IPC calls for exactly this reason, and
// the preview is drawn from the package itself rather than from anything the sender claimed
// out-of-band — so the promise and the result are the same object.
//
// TWO GATES, NOT ONE. `profile_import_inspect` refuses in Rust before the bytes reach the frontend,
// and `inspectPackage` refuses again in TypeScript before anything is drawn. That is not
// belt-and-braces for its own sake: the second gate is the one that can say WHICH rule was broken in
// the reader's own language, and the first is the one that holds even if the frontend is wrong.
//
// FRAME 16 IS NOT HERE. The missing-font state belongs to the stage that carries fonts; a package
// today sends font NAMES, and an absent family already falls back through the CSS stack without
// anything to announce.
//
// NO "TRY IT". The study proposed previewing a profile by wearing it; the design deliberately offers
// Cancel and Import only, and importing is additive and reversible by deleting. Adding a mode the
// designer chose not to draw would be scope, not fidelity.

import { useState } from "react";
import { createPortal } from "react-dom";

import { useI18n } from "../../i18n";
import type { TKey } from "../../i18n/locales/en";
import { profileImportInspect } from "../../lib/ipc";
import { inspectPackage, summarise } from "./model/package";
import { applyProfile, importProfile } from "./store";
import type { Profile } from "./model/profile";

type Stage =
  | { at: "picking" }
  | { at: "preview"; text: string; sum: ReturnType<typeof summarise>; bytes: number }
  | { at: "done"; profile: Profile }
  | { at: "refused"; code: string; detail: string | null };

export function ImportSheet({
  onClose,
  onEdit,
  initialText,
}: {
  onClose: () => void;
  onEdit: (p: Profile) => void;
  /**
   * A manifest ALREADY returned by `profile_import_inspect` — the drag-and-drop path.
   *
   * It still goes through `inspectPackage` here, exactly as a picked file does: the drop reused the
   * Rust gate, and this is the second gate. Nothing skips validation; only the file CHOOSER is
   * skipped, because the reader already chose by dropping.
   */
  initialText?: string;
}) {
  const { t } = useI18n();
  const [stage, setStage] = useState<Stage>(() => {
    if (!initialText) return { at: "picking" };
    const seen = inspectPackage(initialText);
    return seen.ok
      ? { at: "preview", text: initialText, sum: summarise(seen),
          bytes: new TextEncoder().encode(initialText).length }
      : { at: "refused", code: seen.refusal.code,
          detail: "field" in seen.refusal ? seen.refusal.field : null };
  });
  const [busy, setBusy] = useState(false);

  const pick = async () => {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const picked = await open({
      multiple: false,
      filters: [{ name: "Sard profile", extensions: ["zip"] }],
    });
    if (typeof picked !== "string") {
      onClose();
      return;
    }
    setBusy(true);
    try {
      // Gate one: Rust. Refuses before the bytes are ever drawn.
      const text = await profileImportInspect(picked);
      // Gate two: the pure validator, which can name the rule that was broken.
      const seen = inspectPackage(text);
      if (!seen.ok) {
        setStage({
          at: "refused",
          code: seen.refusal.code,
          detail: "field" in seen.refusal ? seen.refusal.field : null,
        });
        return;
      }
      setStage({
        at: "preview",
        text,
        sum: summarise(seen),
        bytes: new TextEncoder().encode(text).length,
      });
    } catch (e) {
      const raw = String(e);
      const [code, detail] = raw.split(":");
      setStage({
        at: "refused",
        code: code.startsWith("pkg.err.") ? code : "pkg.err.unreadable",
        detail: detail ?? null,
      });
    } finally {
      setBusy(false);
    }
  };

  // The picker opens as soon as the sheet does — the sheet IS the import, not a step before it.
  if (stage.at === "picking" && !busy && !initialText) {
    void pick();
    setBusy(true);
    return null;
  }

  const shell = (body: React.ReactNode) =>
    createPortal(
      <div className="pf-dialog-scrim" onClick={onClose}>
        <div className="pf-dialog" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
          {body}
        </div>
      </div>,
      document.body,
    );

  // ---- FRAME 17 — it could not be read, and nothing changed --------------------------------------
  if (stage.at === "refused") {
    return shell(
      <>
        <div className="pf-refused-mark" aria-hidden>!</div>
        <div className="pf-dialog-title">{t("profiles.import.refusedTitle")}</div>
        <p className="pf-dialog-body">{t(stage.code as TKey)}</p>
        {stage.detail && <div className="pf-share-file" dir="ltr">{stage.detail}</div>}
        {/* The one sentence that matters after a refusal. */}
        <div className="pf-hint">{t("profiles.import.nothingChanged")}</div>
        <div className="pf-dialog-actions">
          <button className="pf-btn" onClick={() => { setBusy(false); setStage({ at: "picking" }); }}>
            {t("profiles.import.chooseAnother")}
          </button>
          <button className="pf-btn primary" onClick={onClose}>{t("profiles.share.close")}</button>
        </div>
      </>,
    );
  }

  // ---- FRAME 15 — added, and it is yours ---------------------------------------------------------
  if (stage.at === "done") {
    const p = stage.profile;
    return shell(
      <>
        <div className="pf-dialog-title">
          {t("profiles.import.added", { name: p.name ?? "" })}
        </div>
        <p className="pf-dialog-body">{t("profiles.import.yoursNow")}</p>
        <div className="pf-dialog-actions">
          <button className="pf-btn" onClick={() => { onClose(); onEdit(p); }}>
            {t("profiles.card.edit")}
          </button>
          <button className="pf-btn primary" onClick={() => { void applyProfile(p); onClose(); }}>
            {t("profiles.import.useNow")}
          </button>
        </div>
      </>,
    );
  }

  // ---- FRAME 14 — a profile has reached you ------------------------------------------------------
  // Nothing to preview until the picker has returned something that passed both gates.
  if (stage.at !== "preview") return null;
  const { sum } = stage;
  const rows: [string, string][] = [
    [t("profiles.section.theme"), sum.themeBase ? t(`theme.${sum.themeBase}` as TKey) : t("profiles.theme.custom")],
    [t("profiles.fonts.arabic"), sum.arabic],
    [t("profiles.fonts.latin"), sum.latin],
    [t("profiles.marks.texture"), t(`profiles.texture.${sum.texture}` as TKey)],
  ];

  return shell(
    <>
      <div className="pf-dialog-title">{t("profiles.import.title")}</div>
      <div className="pf-import-name" dir="auto">{sum.name ?? t("profiles.editor.title")}</div>
      {sum.author && <div className="pf-import-author" dir="auto">{sum.author}</div>}

      <div className="pf-share-rows">
        {rows.map(([k, v]) => (
          <div className="pf-share-row" key={k}>
            <span className="pf-share-row-text">
              <span className="pf-share-row-name">{k}</span>
            </span>
            <span className="pf-share-row-note" dir="auto">{v}</span>
          </div>
        ))}
      </div>

      {/* THE FIREWALL, RESTATED WHERE IT IS MOST NEEDED. Someone else's profile is arriving; this is
          the moment the reader most needs to know it cannot touch how they read. */}
      <div className="pf-import-firewall">
        <div className="pf-import-firewall-title">{t("profiles.import.settingsSafe")}</div>
        <p className="pf-import-firewall-body">{t("profiles.notPart.body")}</p>
      </div>
      <div className="pf-hint">{t("profiles.import.additive")}</div>

      <div className="pf-dialog-actions">
        <button className="pf-btn" onClick={onClose}>{t("profiles.theme.cancel")}</button>
        <button
          className="pf-btn primary"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void importProfile(stage.text)
              .then((p) => setStage({ at: "done", profile: p }))
              .catch((e) => setStage({ at: "refused", code: String(e), detail: null }))
              .finally(() => setBusy(false));
          }}
        >
          {t("profiles.import.confirm")}
        </button>
      </div>
    </>,
  );
}
