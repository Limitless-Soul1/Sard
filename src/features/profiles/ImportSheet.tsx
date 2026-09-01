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
// FRAME 16 IS NOT HERE, AND ITS REASON HAS CHANGED. A package now carries an imported font's FILE,
// so the common case the frame was drawn for — "one font is not on this device" — is the case that no
// longer happens. What remains is a font the sender EXCLUDED, and that is already stated in the rows
// below as not included, at the moment the reader can still decline the import.
//
// NO "TRY IT". The study proposed previewing a profile by wearing it; the design deliberately offers
// Cancel and Import only, and importing is additive and reversible by deleting. Adding a mode the
// designer chose not to draw would be scope, not fidelity.

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { useI18n } from "../../i18n";
import type { TKey } from "../../i18n/locales/en";
import { profileImportInspect, profilePackageAsset } from "../../lib/ipc";
import { localeDigits } from "../../lib/format";
import { isBuiltinThemeId } from "../../theme";
import { THEMES } from "../../theme/themes";
import { inspectPackage, summarise, type PackageAsset } from "./model/package";
import { miniOf, sealOf } from "./mini";
import { SardMini } from "./SardMini";
import { applyProfile, importProfile } from "./store";
import type { CustomThemeId } from "../../theme/tokens";
import type { Profile, ProfileData } from "./model/profile";
import { markFrame } from "./model/markFrame";
import { useDialog } from "../../components/useDialog";
import { profileLabel } from "./model/profile";

/**
 * The package, as the PROFILE it is about to become — so the preview and the result are one object.
 *
 * Frame 14's promise is that "the preview is the same miniature the cards use, drawn from the package
 * itself". That only holds if it goes through the SAME `miniOf` and `sealOf` the cards go through,
 * which take a `Profile`. `inspectPackage` already returns the whole of `ProfileData`; nothing new
 * has to travel for this, and nothing here is a second interpretation of a profile's appearance.
 *
 * IT WEARS THE ICON THE PACKAGE CARRIES, when it carries one. The bytes are read out of the archive
 * and held in memory (see usePackagePictures) so the preview shows the face that is arriving
 * without anything being unpacked before the reader says yes. A package with no icon, or one whose
 * icon will not read, falls back to the seal, which is what the imported profile would wear anyway.
 */
function previewProfile(
  name: string | null,
  author: string | null,
  data: ProfileData,
  /** The icon this package carries, if it carries one — see `usePackagePictures`. */
  iconRef: string | null = null,
): Profile {
  return {
    id: "u:preview" as CustomThemeId,
    name,
    description: null,
    author,
    iconKind: iconRef ? "image" : "seal",
    iconRef,
    derivedFrom: null,
    createdAt: 0,
    updatedAt: 0,
    data,
  };
}

/**
 * The package's own pictures, read out of the archive and held as object URLs for the preview.
 *
 * WHY NOT THE ORDINARY PATH. Everywhere else in Sard an icon or a background is resolved from a
 * managed ROW — `iconRef` names a `backgrounds` row and `bgSrcUrl` turns it into an asset URL. Before
 * an import there is no row, because nothing is unpacked until the reader says yes, so that path has
 * nothing to resolve. The mechanism is not bypassed here; it simply does not exist yet at this
 * moment, and the honest substitute is the bytes themselves: read from the archive, held in memory,
 * never written. After the import the ordinary path takes over and the card resolves the real row.
 *
 * Revoked on unmount, so a preview the reader cancels leaves nothing behind — not even a blob.
 */
function usePackagePictures(path: string | null, assets: PackageAsset[]) {
  const [urls, setUrls] = useState<{ icon: string | null; library: string | null }>({
    icon: null,
    library: null,
  });
  useEffect(() => {
    if (!path) return;
    let alive = true;
    const made: string[] = [];
    const want = (kind: string, surface?: string) =>
      assets.find((a) =>
        kind === "icon"
          ? a.kind === "icon"
          : a.kind === "background" && (a.surfaces ?? []).includes(surface ?? ""),
      );
    const load = async (a: PackageAsset | undefined) => {
      if (!a) return null;
      try {
        const bytes = await profilePackageAsset(path, a.member);
        const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)]));
        made.push(url);
        return url;
      } catch {
        // A picture that will not read is simply not shown — the seal and the colours still are.
        return null;
      }
    };
    void (async () => {
      const [icon, library] = await Promise.all([load(want("icon")), load(want("background", "library"))]);
      if (alive) setUrls({ icon, library });
      else made.forEach(URL.revokeObjectURL);
    })();
    return () => {
      alive = false;
      made.forEach(URL.revokeObjectURL);
    };
  }, [path, assets]);
  return urls;
}

/**
 * "Moonlit Sky, modified" — the design's own subtitle, which names the paper AND says whether it was
 * left alone. Compared against the built-in the package NAMES, over the roles the miniature actually
 * draws; a profile with no base is not "modified", it is a paper of its own.
 */
const PAPER_ROLES = ["paperBg", "surfaceBg", "chromeBg", "chromeBorder", "text", "muted", "accent"] as const;

function paperIsModified(data: ProfileData): boolean {
  const base = data.theme.library.base;
  if (!base || !isBuiltinThemeId(base)) return false;
  const b = THEMES[base].colors as unknown as Record<string, unknown>;
  const c = data.theme.library.colors as unknown as Record<string, unknown>;
  return PAPER_ROLES.some((k) => b[k] !== c[k]);
}

const EMPTY_ASSETS: PackageAsset[] = [];

type Stage =
  | { at: "picking" }
  // `data` rides along with the summary: the miniature needs the whole of it, and `summarise`
  // narrows to the four fields the old row list happened to want.
  | { at: "preview"; text: string; path: string | null; sum: ReturnType<typeof summarise>; data: ProfileData; assets: PackageAsset[]; bytes: number }
  | { at: "done"; profile: Profile }
  | { at: "refused"; code: string; detail: string | null };

export function ImportSheet({
  onClose,
  onEdit,
  initialText,
  initialPath,
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
  /** The archive `initialText` was read from — the assets live there, not in the manifest. */
  initialPath?: string | null;
}) {
  const { t, lang } = useI18n();
  const [stage, setStage] = useState<Stage>(() => {
    if (!initialText) return { at: "picking" };
    const seen = inspectPackage(initialText);
    return seen.ok
      ? { at: "preview", text: initialText, path: initialPath ?? null, sum: summarise(seen), data: seen.data,
          assets: seen.manifest.assets ?? [],
          bytes: new TextEncoder().encode(initialText).length }
      : { at: "refused", code: seen.refusal.code,
          detail: "field" in seen.refusal ? seen.refusal.field : null };
  });
  const [busy, setBusy] = useState(false);
  // Read on every render rather than inside the preview branch: a hook cannot live behind a return.
  const pics = usePackagePictures(
    stage.at === "preview" ? stage.path : null,
    stage.at === "preview" ? stage.assets : EMPTY_ASSETS,
  );

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
        path: picked,
        sum: summarise(seen),
        data: seen.data,
        assets: seen.manifest.assets ?? [],
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

  /**
   * THE PICKER OPENS ONCE PER ENTRY INTO `picking` — from an EFFECT, and latched.
   *
   * This used to be three statements in the render body:
   *
   *     if (stage.at === "picking" && !busy && !initialText) { void pick(); setBusy(true); return null; }
   *
   * and `useDialog` was called AFTER it. Both halves were wrong, and together they produced the
   * reported fault exactly:
   *
   *   · `setBusy(true)` during render scheduled a second render immediately, and that render fell
   *     THROUGH the early return and reached `useDialog`. The hook count changed between two
   *     renders of the same component, which React treats as fatal — measured, the console carried
   *     "React has detected a change in the order of Hooks" and "Update hook called on initial
   *     render", and the whole settings surface went blank (document text length 0).
   *   · the crash unmounted the sheet, `stage` was rebuilt as `picking`, and `pick()` ran again.
   *     Measured from one click: TWO native "Open" dialogs, which is the loop the reader saw.
   *
   * A side effect belongs in an effect, and every hook must run on every render. Both are now true.
   *
   * THE LATCH IS NOT BELT-AND-BRACES. StrictMode is on (`main.tsx`), so React deliberately invokes
   * every effect twice in development; without the ref this would open the chooser twice again, for
   * a completely different reason. The ref is reset whenever the sheet leaves `picking`, so
   * «اختر ملفًا آخر» — which sends it back there — still opens the chooser exactly once more.
   */
  const asked = useRef(false);
  useEffect(() => {
    if (initialText || stage.at !== "picking") {
      asked.current = false;
      return;
    }
    if (asked.current) return;
    asked.current = true;
    void pick();
    // `pick` is redefined every render and deliberately not a dependency: the latch above, not the
    // identity of the function, is what decides when the chooser may open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage.at, initialText]);

  // `wide` is frame 14 only: the design draws that one card at 560px because it leads with a
  // full-width miniature. Every other state here is an ordinary 420px dialog, as it is elsewhere.
  //
  // CALLED BEFORE ANY RETURN, unconditionally. `useDialog` is built for exactly this — its own
  // comment describes dialogs "mounted the whole time [that] merely render `null` until they are
  // opened" — so holding it above the early return is how it is meant to be used, not a dodge.
  const dlg = useDialog({ onDismiss: onClose });

  // Nothing is drawn while the chooser is open: the sheet IS the import, not a step before it.
  // A pure return now — no side effect, no state update, no hook skipped.
  if (stage.at === "picking") return null;

  const shell = (body: React.ReactNode, wide = false) =>
    createPortal(
      <div className="pf-dialog-scrim" onClick={onClose}>
        <div
          className={`pf-dialog${wide ? " pf-import-card" : ""}`}
          onClick={(e) => e.stopPropagation()}
          ref={dlg.ref}
          {...dlg.props}
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
        <div className="pf-dialog-title" id={dlg.titleId}>{t("profiles.import.refusedTitle")}</div>
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
  const seen = previewProfile(sum.name, sum.author, data, pics.icon);
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
      <div className="pf-dialog-title" id={dlg.titleId}>{t("profiles.import.title")}</div>

      {/* THE MINIATURE IS THE PREVIEW. Frame 14 leads with it because the question the reader is
          answering is "what will Sard look like", and the honest answer is a picture of Sard drawn
          from the package's own colours — the same component, through the same `miniOf`, that every
          card uses. Its 16:10 is SardMini's own, so the design's 325px is simply what 100% of this
          card's width comes to. */}
      <div className="pf-import-hero">
        <SardMini p={miniOf(seen, pics.library)} />
      </div>

      <div className="pf-import-id">
        {pics.icon ? (
          // Nested exactly as the card nests it, so one rule draws an image seal everywhere.
          <span className="pf-import-seal" aria-hidden>
            <span
              className="pf-seal-img"
              style={{ backgroundImage: `url("${pics.icon}")`, ...markFrame(seen.data.icon) }}
            />
          </span>
        ) : (
          <span className="pf-import-seal" style={{ fontFamily: seal.fontFamily }} aria-hidden>
            {seal.text}
          </span>
        )}
        <span className="pf-import-id-text">
          <span className="pf-import-name" dir="auto">{profileLabel(sum.name, t("profiles.unnamed"))}</span>
          <span className="pf-import-author" dir="auto">
            {paperIsModified(data) ? `${paper} · ${t("profiles.import.modified")}` : paper}
            {" · "}
            {t("profiles.share.kb", { n: localeDigits(String(kb), lang) })}
            {sum.author ? ` · ${sum.author}` : ""}
          </span>
        </span>
      </div>

      <div className="pf-import-rows">
        {/* WHAT IS ACTUALLY IN THIS ARCHIVE. Read from the manifest's own claims rather than from a
            list of what a profile could have — a package whose sender switched the picture off says
            so here, at the moment declining still costs nothing. */}
        {stage.assets.map((a) => (
          <div className="pf-import-row" key={a.member}>
            <span className="pf-import-dot" aria-hidden />
            <span className="pf-import-row-name">
              {a.kind === "font"
                ? t("profiles.chapter.fonts")
                : a.kind === "icon"
                  ? t("profiles.share.row.icon")
                  : t("profiles.share.row.libraryBg")}
            </span>
            <span className="pf-import-row-val" dir="auto">{a.name}</span>
          </div>
        ))}
        {rows.map(([k, v]) => (
          <div className="pf-import-row" key={k}>
            <span className="pf-import-dot" aria-hidden />
            <span className="pf-import-row-name">{k}</span>
            <span className="pf-import-row-val" dir="auto">{v}</span>
          </div>
        ))}
      </div>

      {/* THE FIREWALL, RESTATED WHERE IT IS MOST NEEDED. Someone else's profile is arriving; this is
          the moment the reader most needs to know it cannot touch how they read.

          ITS OWN WORDING, and not the editor's. The two claims are no longer the same claim: a هيئة
          the reader is AUTHORING may carry the measure — the measure chapter is what that chapter
          is — while one ARRIVING may not, because `exportable` holds it back and the validator
          refuses any package that carries it by name. One string could only be right about one of
          them, and the stronger promise belongs here, where it is the one actually enforced. */}
      <div className="pf-import-firewall">
        <div className="pf-import-firewall-title">{t("profiles.import.settingsSafe")}</div>
        <p className="pf-import-firewall-body">{t("profiles.import.notPart.body")}</p>
      </div>
      <div className="pf-hint">{t("profiles.import.additive")}</div>

      <div className="pf-dialog-actions">
        <button className="pf-btn" onClick={onClose}>{t("profiles.theme.cancel")}</button>
        <button
          className="pf-btn primary"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void importProfile(stage.text, stage.path)
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
