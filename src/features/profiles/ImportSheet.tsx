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
import { localeDigits } from "../../lib/format";
import { isBuiltinThemeId } from "../../theme";
import { THEMES } from "../../theme/themes";
import { inspectPackage, summarise } from "./model/package";
import { miniOf, sealOf } from "./mini";
import { SardMini } from "./SardMini";
import { applyProfile, importProfile } from "./store";
import type { CustomThemeId } from "../../theme/tokens";
import type { Profile, ProfileData } from "./model/profile";

/**
 * The package, as the PROFILE it is about to become — so the preview and the result are one object.
 *
 * Frame 14's promise is that "the preview is the same miniature the cards use, drawn from the package
 * itself". That only holds if it goes through the SAME `miniOf` and `sealOf` the cards go through,
 * which take a `Profile`. `inspectPackage` already returns the whole of `ProfileData`; nothing new
 * has to travel for this, and nothing here is a second interpretation of a profile's appearance.
 *
 * `iconKind: "seal"` is not a placeholder — it is the truth. The manifest carries no icon (see
 * `PackageManifest`), so an imported profile wears a seal, and showing one here is showing what will
 * actually arrive rather than a picture of what the sender had.
 */
function previewProfile(name: string | null, author: string | null, data: ProfileData): Profile {
  return {
    id: "u:preview" as CustomThemeId,
    name,
    description: null,
    author,
    iconKind: "seal",
    iconRef: null,
    derivedFrom: null,
    createdAt: 0,
    updatedAt: 0,
    data,
  };
}

/**
 * "Moonlit Sky, modified" — the design's own subtitle, which names the paper AND says whether it was
 * left alone. Compared against the built-in the package NAMES, over the roles the miniature actually
 * draws; a profile with no base is not "modified", it is a paper of its own.
 */
const PAPER_ROLES = ["paperBg", "surfaceBg", "chromeBg", "chromeBorder", "text", "muted", "accent"] as const;

function paperIsModified(data: ProfileData): boolean {
  const base = data.theme.base;
  if (!base || !isBuiltinThemeId(base)) return false;
  const b = THEMES[base].colors as unknown as Record<string, unknown>;
  const c = data.theme.colors as unknown as Record<string, unknown>;
  return PAPER_ROLES.some((k) => b[k] !== c[k]);
}

type Stage =
  | { at: "picking" }
  // `data` rides along with the summary: the miniature needs the whole of it, and `summarise`
  // narrows to the four fields the old row list happened to want.
  | { at: "preview"; text: string; sum: ReturnType<typeof summarise>; data: ProfileData; bytes: number }
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
  const { t, lang } = useI18n();
  const [stage, setStage] = useState<Stage>(() => {
    if (!initialText) return { at: "picking" };
    const seen = inspectPackage(initialText);
    return seen.ok
      ? { at: "preview", text: initialText, sum: summarise(seen), data: seen.data,
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
        data: seen.data,
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

  // `wide` is frame 14 only: the design draws that one card at 560px because it leads with a
  // full-width miniature. Every other state here is an ordinary 420px dialog, as it is elsewhere.
  const shell = (body: React.ReactNode, wide = false) =>
    createPortal(
      <div className="pf-dialog-scrim" onClick={onClose}>
        <div
          className={`pf-dialog${wide ? " pf-import-card" : ""}`}
          onClick={(e) => e.stopPropagation()}
          role="dialog"
          aria-modal="true"
        >
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
  // The design puts the miniature BESIDE the sentence rather than above it: the profile is no longer
  // an arriving file to be inspected, it is one of yours, so it is introduced the way a card is.
  if (stage.at === "done") {
    const p = stage.profile;
    return shell(
      <>
        <div className="pf-imported-head">
          <span className="pf-imported-mini">
            <SardMini p={miniOf(p, null)} />
          </span>
          <span className="pf-imported-text">
            <span className="pf-imported-title">
              {t("profiles.import.added", { name: p.name ?? "" })}
            </span>
            <span className="pf-imported-body">{t("profiles.import.yoursNow")}</span>
          </span>
        </div>
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
  const { sum, data } = stage;
  const paper = sum.themeBase ? t(`theme.${sum.themeBase}` as TKey) : t("profiles.theme.custom");
  const kb = Math.max(1, Math.round(stage.bytes / 1024));
  const seen = previewProfile(sum.name, sum.author, data);
  const seal = sealOf(seen);

  // The design's own row set, minus the two it draws for assets that do not travel yet — a package
  // carries no image and no icon, and a row claiming otherwise would be the one thing frame 14 exists
  // to prevent. Fonts are ONE row here as they are in the design, holding both scripts.
  const rows: [string, string][] = [
    [t("profiles.chapter.paper"), paper],
    [t("profiles.chapter.fonts"), `${sum.arabic} · ${sum.latin}`],
    [t("profiles.chapter.marks"), t(`profiles.shape.${data.marks.bookmarkShape}` as TKey)],
    [t("profiles.marks.texture"), t(`profiles.texture.${sum.texture}` as TKey)],
  ];

  return shell(
    <>
      <div className="pf-dialog-title">{t("profiles.import.title")}</div>

      {/* THE MINIATURE IS THE PREVIEW. Frame 14 leads with it because the question the reader is
          answering is "what will Sard look like", and the honest answer is a picture of Sard drawn
          from the package's own colours — the same component, through the same `miniOf`, that every
          card uses. Its 16:10 is SardMini's own, so the design's 325px is simply what 100% of this
          card's width comes to. */}
      <div className="pf-import-hero">
        <SardMini p={miniOf(seen, null)} />
      </div>

      <div className="pf-import-id">
        <span className="pf-import-seal" style={{ fontFamily: seal.fontFamily }} aria-hidden>
          {seal.text}
        </span>
        <span className="pf-import-id-text">
          <span className="pf-import-name" dir="auto">{sum.name ?? t("profiles.editor.title")}</span>
          <span className="pf-import-author" dir="auto">
            {paperIsModified(data) ? `${paper} · ${t("profiles.import.modified")}` : paper}
            {" · "}
            {t("profiles.share.kb", { n: localeDigits(String(kb), lang) })}
            {sum.author ? ` · ${sum.author}` : ""}
          </span>
        </span>
      </div>

      <div className="pf-import-rows">
        {rows.map(([k, v]) => (
          <div className="pf-import-row" key={k}>
            <span className="pf-import-dot" aria-hidden />
            <span className="pf-import-row-name">{k}</span>
            <span className="pf-import-row-val" dir="auto">{v}</span>
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
    true,
  );
}
